"""SQLAlchemy models for persisting game state."""

from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class GameRecord(Base):
    """Stores serialized game state in Postgres."""
    __tablename__ = "games"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    state_json = Column(Text, nullable=False)  # Full serialized GameState
    status = Column(String(20), default="active")  # active, finished
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
