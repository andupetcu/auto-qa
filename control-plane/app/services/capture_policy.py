"""Versioned, bounded visual-capture and readiness policy normalization."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.problems import ProblemException
from app.settings import Settings

_DEFAULT_MASK_SELECTORS = [
    "input[type='password']",
    "input[autocomplete='current-password']",
    "[data-sensitive='true']",
]
_RESOURCE_TYPES = Literal[
    "fetch", "xhr", "document", "script", "stylesheet", "image", "font", "media", "other"
]


class _PolicyModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FinalScreenshotPolicy(_PolicyModel):
    enabled: bool = True
    full_page: bool = Field(default=True, alias="fullPage")
    format: Literal["png", "jpeg"] = "png"


class LoadingSequencePolicy(_PolicyModel):
    enabled: bool = True
    max_frames: int = Field(default=12, ge=1, le=12, alias="maxFrames")
    milestones: list[
        Literal["navigation", "domcontentloaded", "asserted"]
    ] = Field(default_factory=lambda: ["navigation", "domcontentloaded", "asserted"], max_length=3)
    delays_ms: list[int] = Field(
        default_factory=lambda: [250, 750, 1500, 3000, 6000, 10000],
        alias="delaysMs",
        max_length=6,
    )

    @field_validator("milestones")
    @classmethod
    def unique_milestones(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("milestones must be unique")
        return value

    @field_validator("delays_ms")
    @classmethod
    def ordered_non_negative_delays(cls, value: list[int]) -> list[int]:
        if any(delay < 0 for delay in value):
            raise ValueError("delaysMs cannot contain negative values")
        if value != sorted(set(value)):
            raise ValueError("delaysMs must be unique and ascending")
        return value


class ContactSheetPolicy(_PolicyModel):
    enabled: bool = True
    format: Literal["webp"] = "webp"
    quality: int = Field(default=80, ge=40, le=95)


class RequestRule(_PolicyModel):
    url_glob: str = Field(alias="urlGlob", min_length=1, max_length=500)
    methods: list[str] = Field(default_factory=list, max_length=20)
    resource_types: list[_RESOURCE_TYPES] = Field(default_factory=list, alias="resourceTypes", max_length=9)

    @field_validator("url_glob")
    @classmethod
    def safe_glob(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("urlGlob must be a non-empty safe glob")
        return value

    @field_validator("methods")
    @classmethod
    def uppercase_unique_methods(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[A-Z]+", method) for method in value):
            raise ValueError("methods must contain uppercase HTTP methods")
        if len(value) != len(set(value)):
            raise ValueError("methods must be unique")
        return value

    @field_validator("resource_types")
    @classmethod
    def unique_resource_types(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("resourceTypes must be unique")
        return value


class ReadinessPolicy(_PolicyModel):
    version: Literal[1] = 1
    enabled: bool = True
    timeout_ms: int = Field(default=20000, ge=1000, le=120000, alias="timeoutMs")
    poll_interval_ms: int = Field(default=250, ge=50, le=5000, alias="pollIntervalMs")
    capture_interval_ms: int = Field(default=1000, ge=100, le=30000, alias="captureIntervalMs")
    stability_window_ms: int = Field(default=1000, ge=0, le=10000, alias="stabilityWindowMs")
    visual_diff_ratio: float = Field(default=0.005, ge=0, le=0.2, alias="visualDiffRatio")
    ready_selectors: list[str] = Field(default_factory=list, alias="readySelectors", max_length=50)
    loading_selectors: list[str] = Field(default_factory=list, alias="loadingSelectors", max_length=50)
    critical_requests: list[RequestRule] = Field(
        default_factory=lambda: [RequestRule(urlGlob="*", methods=[], resourceTypes=["fetch", "xhr"])],
        alias="criticalRequests",
        max_length=50,
    )
    ignored_requests: list[RequestRule] = Field(default_factory=list, alias="ignoredRequests", max_length=50)
    fail_on_page_error: bool = Field(default=True, alias="failOnPageError")
    fail_on_console_error: bool = Field(default=True, alias="failOnConsoleError")
    fail_on_critical_request: bool = Field(default=True, alias="failOnCriticalRequest")

    @field_validator("ready_selectors", "loading_selectors")
    @classmethod
    def safe_unique_selectors(cls, value: list[str]) -> list[str]:
        selectors = [selector.strip() for selector in value]
        if any(not selector or len(selector) > 500 for selector in selectors):
            raise ValueError("selectors must be non-empty and at most 500 characters")
        if len(selectors) != len(set(selectors)):
            raise ValueError("selectors must be unique")
        return selectors


class CapturePolicy(_PolicyModel):
    version: Literal[1] = 1
    final_screenshot: FinalScreenshotPolicy = Field(default_factory=FinalScreenshotPolicy, alias="finalScreenshot")
    loading_sequence: LoadingSequencePolicy = Field(default_factory=LoadingSequencePolicy, alias="loadingSequence")
    contact_sheet: ContactSheetPolicy = Field(default_factory=ContactSheetPolicy, alias="contactSheet")
    trace: Literal["off", "on", "retain-on-failure"] = "on"
    video: Literal["off", "on", "retain-on-failure"] = "retain-on-failure"
    har: Literal["off", "reduced"] = "reduced"
    retain_intermediate_frames: bool = Field(default=False, alias="retainIntermediateFrames")
    mask_selectors: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_MASK_SELECTORS), alias="maskSelectors", max_length=50
    )
    readiness: ReadinessPolicy = Field(default_factory=ReadinessPolicy)

    @field_validator("mask_selectors")
    @classmethod
    def validate_mask_selectors(cls, value: list[str]) -> list[str]:
        custom = [selector.strip() for selector in value]
        if any(not selector or len(selector) > 500 for selector in custom):
            raise ValueError("maskSelectors must contain non-empty selectors up to 500 characters")
        return list(dict.fromkeys([*_DEFAULT_MASK_SELECTORS, *custom]))


def normalize_capture_policy(
    raw_policy: dict | None,
    settings: Settings,
    project_readiness: dict | None = None,
) -> dict:
    """Validate input and return one canonical immutable policy snapshot."""
    policy_input = dict(raw_policy or {})
    if "readiness" not in policy_input and project_readiness is not None:
        policy_input["readiness"] = project_readiness
    try:
        policy = CapturePolicy.model_validate(policy_input)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        location = ".".join(str(part) for part in first.get("loc", ())) or "capture"
        raise ProblemException(400, "Invalid capture policy", f"{location}: {first['msg']}") from exc

    loading = policy.loading_sequence
    if loading.max_frames > settings.capture_max_frames:
        raise ProblemException(400, "Invalid capture policy", f"loadingSequence.maxFrames exceeds installation limit {settings.capture_max_frames}")
    if any(delay > settings.capture_max_delay_ms for delay in loading.delays_ms):
        raise ProblemException(400, "Invalid capture policy", f"loadingSequence.delaysMs exceeds installation limit {settings.capture_max_delay_ms}")
    if len(policy.mask_selectors) > settings.capture_max_mask_selectors:
        raise ProblemException(400, "Invalid capture policy", f"maskSelectors exceeds installation limit {settings.capture_max_mask_selectors}")
    if policy.contact_sheet.quality > settings.capture_max_contact_sheet_quality:
        raise ProblemException(400, "Invalid capture policy", "contactSheet.quality exceeds installation limit " f"{settings.capture_max_contact_sheet_quality}")

    return policy.model_dump(mode="json", by_alias=True)
