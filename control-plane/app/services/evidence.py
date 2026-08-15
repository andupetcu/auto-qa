"""Central evidence redaction and artifact preparation before persistence."""

import hashlib
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.problems import ProblemException
from app.settings import Settings

REDACTION_VERSION = "evidence-redaction-v1"
REDACTED = "[REDACTED]"

_BEARER_RE = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|session|csrf|password|access[_-]?token|refresh[_-]?token)\s*([:=])\s*([^\s&,;]+)"
)


@dataclass(frozen=True)
class EvidencePolicy:
    """Normalized immutable redaction policy for one ingestion request."""

    headers: frozenset[str]
    query_keys: frozenset[str]
    json_keys: frozenset[str]
    literal_secrets: tuple[str, ...]
    max_body_bytes: int
    version: str = REDACTION_VERSION


def _csv_set(value: str) -> frozenset[str]:
    return frozenset(item.strip().lower() for item in value.split(",") if item.strip())


def _credential_literals(settings: Settings) -> tuple[str, ...]:
    """Load credential values without exposing names or contents in metadata/logs."""
    values = {
        value
        for value in (settings.api_token, settings.signing_secret, settings.webhook_secret)
        if len(value) >= 4
    }
    path = Path(settings.credentials_file)
    if path.is_file():
        for line in path.read_text(errors="replace").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key_upper = key.strip().upper()
            if not any(
                marker in key_upper
                for marker in ("CRED", "PASSWORD", "TOKEN", "SECRET", "SESSION", "API_KEY", "FIXTURE")
            ):
                continue
            value = value.strip().strip('"').strip("'")
            if len(value) >= 4:
                values.add(value)
    return tuple(sorted(values, key=lambda item: (-len(item), item)))


def evidence_policy(settings: Settings) -> EvidencePolicy:
    """Build the active policy from QA_-prefixed installation configuration."""
    return EvidencePolicy(
        headers=_csv_set(settings.evidence_redact_headers),
        query_keys=_csv_set(settings.evidence_redact_query_keys),
        json_keys=_csv_set(settings.evidence_redact_json_keys),
        literal_secrets=_credential_literals(settings),
        max_body_bytes=settings.evidence_max_body_bytes,
    )


def _redact_url(value: str, policy: EvidencePolicy) -> str:
    """Redact sensitive query values and remove URL fragments."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return value
    if not parsed.query and not parsed.fragment:
        return value
    query = urlencode(
        [
            (key, REDACTED if key.lower() in policy.query_keys else item_value)
            for key, item_value in parse_qsl(parsed.query, keep_blank_values=True)
        ],
        doseq=True,
    )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


def redact_string(value: str, policy: EvidencePolicy) -> str:
    """Redact literals, bearer credentials, assignments, JSON strings, and URLs."""
    redacted = value
    for secret in policy.literal_secrets:
        redacted = redacted.replace(secret, REDACTED)
    redacted = _BEARER_RE.sub(f"Bearer {REDACTED}", redacted)
    redacted = _SENSITIVE_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}", redacted
    )

    stripped = redacted.strip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(redacted)
        except (json.JSONDecodeError, TypeError):
            pass
        else:
            return json.dumps(redact_value(parsed, policy), separators=(",", ":"))

    return _redact_url(redacted, policy)


def redact_value(value: Any, policy: EvidencePolicy) -> Any:
    """Recursively redact a JSON-compatible evidence value."""
    if isinstance(value, dict):
        header_name = value.get("name")
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in policy.json_keys or lowered in policy.headers:
                redacted[key] = REDACTED
            elif (
                key == "value"
                and isinstance(header_name, str)
                and header_name.lower() in policy.headers
            ):
                redacted[key] = REDACTED
            else:
                redacted[key] = redact_value(item, policy)
        return redacted
    if isinstance(value, list):
        return [redact_value(item, policy) for item in value]
    if isinstance(value, str):
        return redact_string(value, policy)
    return value


def _truncate_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore") + "…[TRUNCATED]"


def _bound_har_bodies(value: Any, max_bytes: int) -> None:
    """Bound request/response body strings in a redacted HAR object in place."""
    if not isinstance(value, dict):
        return
    for entry in value.get("log", {}).get("entries", []):
        if not isinstance(entry, dict):
            continue
        request_text = entry.get("request", {}).get("postData", {}).get("text")
        if isinstance(request_text, str):
            entry["request"]["postData"]["text"] = _truncate_utf8(
                request_text, max_bytes
            )
        response_text = entry.get("response", {}).get("content", {}).get("text")
        if isinstance(response_text, str):
            entry["response"]["content"]["text"] = _truncate_utf8(
                response_text, max_bytes
            )


def _rewrite_zip(path: Path, policy: EvidencePolicy) -> None:
    """Rewrite textual Playwright trace members; drop opaque members containing literals."""
    replacement = path.with_suffix(path.suffix + ".redacted")
    with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
        replacement, "w", compression=zipfile.ZIP_DEFLATED
    ) as target:
        for info in source.infolist():
            raw = source.read(info.filename)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                if any(secret.encode() in raw for secret in policy.literal_secrets):
                    continue
                target.writestr(info, raw)
            else:
                target.writestr(info, redact_string(text, policy).encode("utf-8"))
    replacement.replace(path)


def artifact_metadata_path(path: Path) -> Path:
    """Return the non-retrievable metadata sidecar path for an artifact."""
    return path.with_name(path.name + ".metadata.json")


def prepare_artifact(
    settings: Settings,
    run_id: str,
    artifact_type: str,
    storage_key: str,
    policy: EvidencePolicy,
    result_id: str | None = None,
) -> tuple[Path, int]:
    """Validate ownership, redact the file in place, and persist policy metadata."""
    base_dir = Path(settings.artifacts_dir).resolve()
    target = (base_dir / storage_key).resolve()
    expected_root = (base_dir / "runs" / run_id).resolve()
    try:
        target.relative_to(expected_root)
    except ValueError as exc:
        raise ProblemException(
            400,
            "Invalid artifact key",
            "Artifact must be stored beneath its owning run directory",
        ) from exc
    if not target.is_file():
        raise ProblemException(400, "Missing artifact", "Referenced artifact file is missing")

    if artifact_type == "har":
        try:
            payload = json.loads(target.read_text(errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProblemException(400, "Invalid artifact", "HAR artifact is not valid JSON") from exc
        payload = redact_value(payload, policy)
        _bound_har_bodies(payload, policy.max_body_bytes)
        target.write_text(json.dumps(payload, separators=(",", ":")))
    elif artifact_type == "console":
        lines = []
        for line in target.read_text(errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                lines.append(redact_string(line, policy))
            else:
                lines.append(json.dumps(redact_value(item, policy), separators=(",", ":")))
        target.write_text("\n".join(lines) + ("\n" if lines else ""))
    elif artifact_type == "trace":
        if not zipfile.is_zipfile(target):
            raise ProblemException(
                400, "Invalid artifact", "Trace artifact is not a valid ZIP archive"
            )
        _rewrite_zip(target, policy)
    elif artifact_type == "visual_manifest":
        try:
            payload = json.loads(target.read_text(errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProblemException(
                400, "Invalid artifact", "Visual manifest is not valid JSON"
            ) from exc
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
            raise ProblemException(
                400, "Invalid artifact", "Unsupported visual manifest schema"
            )
        payload["resultId"] = result_id
        payload = redact_value(payload, policy)
        target.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    elif target.suffix.lower() in {".json", ".jsonl", ".txt", ".log", ".html"}:
        target.write_text(redact_string(target.read_text(errors="replace"), policy))

    content = target.read_bytes()
    metadata = {
        "redaction_version": policy.version,
        "state": "redacted",
        "raw_variant_retrievable": False,
        "_sha256": hashlib.sha256(content).hexdigest(),
        "_bytes": len(content),
    }
    artifact_metadata_path(target).write_text(
        json.dumps(metadata, sort_keys=True, separators=(",", ":"))
    )
    return target, target.stat().st_size


def _verify_manifest_descriptor(
    descriptor: Any,
    candidates: list[Path],
    label: str,
) -> Path | None:
    if descriptor is None:
        if candidates:
            raise ProblemException(
                400,
                "Visual evidence integrity failure",
                f"{label} is missing for an ingested artifact",
            )
        return None
    if not isinstance(descriptor, dict):
        raise ProblemException(
            400, "Visual evidence integrity failure", f"{label} descriptor is invalid"
        )
    filename = descriptor.get("filename")
    matches = [path for path in candidates if path.name == filename]
    if len(matches) != 1:
        raise ProblemException(
            400,
            "Visual evidence integrity failure",
            f"{label} does not reference exactly one ingested artifact",
        )
    match = matches[0]
    content = match.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if descriptor.get("sha256") != digest or descriptor.get("bytes") != len(content):
        raise ProblemException(
            400,
            "Visual evidence integrity failure",
            f"{label} hash or byte count does not match the stored artifact",
        )
    return match


def validate_visual_artifact_set(
    settings: Settings,
    prepared_artifacts: list[tuple[Any, int]],
) -> None:
    """Bind a v1 manifest to the exact visual bytes being persisted for one result."""
    manifests = [artifact for artifact, _ in prepared_artifacts if artifact.type == "visual_manifest"]
    visual_types = {"screenshot", "screenshot_frame", "contact_sheet"}
    visual_artifacts = [artifact for artifact, _ in prepared_artifacts if artifact.type in visual_types]
    if not manifests:
        if visual_artifacts:
            raise ProblemException(
                400,
                "Visual evidence integrity failure",
                "Visual artifacts require exactly one visual manifest",
            )
        return
    if len(manifests) != 1:
        raise ProblemException(
            400, "Visual evidence integrity failure", "Exactly one visual manifest is allowed"
        )
    root = Path(settings.artifacts_dir).resolve()
    manifest_path = (root / manifests[0].storage_key).resolve()
    manifest_parent = manifest_path.parent
    for artifact in visual_artifacts:
        if (root / artifact.storage_key).resolve().parent != manifest_parent:
            raise ProblemException(
                400,
                "Visual evidence integrity failure",
                "Visual artifacts must share the manifest result directory",
            )
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ProblemException(
            400, "Visual evidence integrity failure", "Visual manifest cannot be read"
        ) from exc

    paths_by_type: dict[str, list[Path]] = {}
    for artifact, _ in prepared_artifacts:
        paths_by_type.setdefault(artifact.type, []).append(
            (root / artifact.storage_key).resolve()
        )
    screenshots = paths_by_type.get("screenshot", [])
    sheets = paths_by_type.get("contact_sheet", [])
    if len(screenshots) > 1 or len(sheets) > 1:
        raise ProblemException(
            400,
            "Visual evidence integrity failure",
            "Manifest permits at most one final screenshot and contact sheet",
        )
    _verify_manifest_descriptor(manifest.get("finalScreenshot"), screenshots, "finalScreenshot")
    _verify_manifest_descriptor(manifest.get("contactSheet"), sheets, "contactSheet")

    retained_frames = paths_by_type.get("screenshot_frame", [])
    frames = manifest.get("frames")
    if not isinstance(frames, list):
        raise ProblemException(
            400, "Visual evidence integrity failure", "frames must be an array"
        )
    matched_frames: list[Path] = []
    retained_names = {path.name for path in retained_frames}
    for index, descriptor in enumerate(frames):
        if not isinstance(descriptor, dict):
            raise ProblemException(
                400,
                "Visual evidence integrity failure",
                f"frames[{index}] descriptor is invalid",
            )
        if descriptor.get("filename") in retained_names:
            match = _verify_manifest_descriptor(
                descriptor, retained_frames, f"frames[{index}]"
            )
            if match is not None:
                matched_frames.append(match)
    if len(matched_frames) != len(set(matched_frames)) or set(matched_frames) != set(retained_frames):
        raise ProblemException(
            400,
            "Visual evidence integrity failure",
            "Retained frame artifacts must be referenced exactly once",
        )


def read_artifact_metadata(settings: Settings, storage_key: str) -> dict[str, Any]:
    """Read sidecar metadata without trusting paths outside the artifact root."""
    base_dir = Path(settings.artifacts_dir).resolve()
    target = (base_dir / storage_key).resolve()
    try:
        target.relative_to(base_dir)
    except ValueError:
        return {"redaction_version": "legacy-unverified", "state": "unknown"}
    sidecar = artifact_metadata_path(target)
    if not sidecar.is_file():
        return {"redaction_version": "legacy-unverified", "state": "unknown"}
    try:
        payload = json.loads(sidecar.read_text())
    except (OSError, json.JSONDecodeError):
        return {"redaction_version": "legacy-unverified", "state": "unknown"}
    if not isinstance(payload, dict):
        return {"redaction_version": "legacy-unverified", "state": "unknown"}
    return {key: value for key, value in payload.items() if not key.startswith("_")}
