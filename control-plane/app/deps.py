"""Shared FastAPI dependencies: settings, DB session, bearer-token auth."""
from fastapi import Depends, Request

from app.problems import ProblemException
from app.settings import Settings


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_session(request: Request):
    session_local = request.app.state.SessionLocal
    session = session_local()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def require_auth(request: Request, settings: Settings = Depends(get_settings)) -> None:
    auth = request.headers.get("Authorization", "")
    token = auth[len("Bearer ") :] if auth.startswith("Bearer ") else None
    if not token or token != settings.api_token:
        raise ProblemException(401, "Unauthorized", "Missing or invalid bearer token")
