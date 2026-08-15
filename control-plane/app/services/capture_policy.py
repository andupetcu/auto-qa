"""Versioned, bounded visual-capture policy normalization for immutable run snapshots."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.problems import ProblemException
from app.settings import Settings

_DEFAULT_MASK_SELECTORS = [
    "input[type='password']",
    "input[autocomplete='current-password']",
    "[data-sensitive='true']",
]


class _PolicyModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FinalScreenshotPolicy(_PolicyModel):
    enabled: bool = True
    full_page: bool = Field(default=True, alias="fullPage")
    format: Literal["png", "jpeg"] = "png"


class LoadingSequencePolicy(_PolicyModel):
    enabled: bool = True
    max_frames: int = Field(default=6, ge=1, le=12, alias="maxFrames")
    milestones: list[
        Literal["navigation", "domcontentloaded", "asserted"]
    ] = Field(default_factory=lambda: ["navigation", "domcontentloaded", "asserted"], max_length=3)
    delays_ms: list[int] = Field(
        default_factory=lambda: [250, 750, 1500],
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


class CapturePolicy(_PolicyModel):
    version: Literal[1] = 1
    final_screenshot: FinalScreenshotPolicy = Field(
        default_factory=FinalScreenshotPolicy, alias="finalScreenshot"
    )
    loading_sequence: LoadingSequencePolicy = Field(
        default_factory=LoadingSequencePolicy, alias="loadingSequence"
    )
    contact_sheet: ContactSheetPolicy = Field(
        default_factory=ContactSheetPolicy, alias="contactSheet"
    )
    trace: Literal["off", "on", "retain-on-failure"] = "on"
    video: Literal["off", "on", "retain-on-failure"] = "retain-on-failure"
    har: Literal["off", "reduced"] = "reduced"
    retain_intermediate_frames: bool = Field(
        default=False, alias="retainIntermediateFrames"
    )
    mask_selectors: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_MASK_SELECTORS),
        alias="maskSelectors",
        max_length=50,
    )

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
) -> dict:
    """Validate client input and return one canonical JSON-compatible policy snapshot."""
    try:
        policy = CapturePolicy.model_validate(raw_policy or {})
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        location = ".".join(str(part) for part in first.get("loc", ())) or "capture"
        raise ProblemException(
            400,
            "Invalid capture policy",
            f"{location}: {first['msg']}",
        ) from exc

    loading = policy.loading_sequence
    if loading.max_frames > settings.capture_max_frames:
        raise ProblemException(
            400,
            "Invalid capture policy",
            f"loadingSequence.maxFrames exceeds installation limit {settings.capture_max_frames}",
        )
    if any(delay > settings.capture_max_delay_ms for delay in loading.delays_ms):
        raise ProblemException(
            400,
            "Invalid capture policy",
            f"loadingSequence.delaysMs exceeds installation limit {settings.capture_max_delay_ms}",
        )
    if len(policy.mask_selectors) > settings.capture_max_mask_selectors:
        raise ProblemException(
            400,
            "Invalid capture policy",
            f"maskSelectors exceeds installation limit {settings.capture_max_mask_selectors}",
        )
    if policy.contact_sheet.quality > settings.capture_max_contact_sheet_quality:
        raise ProblemException(
            400,
            "Invalid capture policy",
            "contactSheet.quality exceeds installation limit "
            f"{settings.capture_max_contact_sheet_quality}",
        )

    return policy.model_dump(mode="json", by_alias=True)
