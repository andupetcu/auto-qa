from fastapi import APIRouter, Depends

from app.deps import get_settings, require_auth
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])

ARTIFACT_TYPES = ["trace", "har", "console", "screenshot", "video"]


@router.get("/capabilities")
def get_capabilities(settings: Settings = Depends(get_settings)):
    return {
        "version": "0.1",
        "roles": settings.roles_list,
        "artifact_types": ARTIFACT_TYPES,
    }
