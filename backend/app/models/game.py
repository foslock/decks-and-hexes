"""SQLAlchemy models for persisting game state and analytics."""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class GameRecord(Base):
    """Stores serialized game state as a JSON blob."""

    __tablename__ = "card_clash_games"

    id = Column(Text, primary_key=True)  # UUID as text (SQLite compat)
    state_snapshot = Column(Text, nullable=False)  # Full GameState JSON blob
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(20), nullable=False, default="active")  # active/finished/abandoned
    map_seed = Column(Text, nullable=False, default="")
    card_pack = Column(Text, nullable=False, default="everything")
    grid_size = Column(Text, nullable=False, default="small")
    player_count = Column(Integer, nullable=False, default=2)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    finished_at = Column(DateTime(timezone=True), nullable=True)


class GamePlayerRecord(Base):
    """Player participation in a game (written at creation + game end)."""

    __tablename__ = "card_clash_game_players"

    game_id = Column(Text, nullable=False, primary_key=True)
    player_id = Column(Text, nullable=False, primary_key=True)
    player_name = Column(Text, nullable=False)
    archetype = Column(Text, nullable=False)
    is_cpu = Column(Boolean, nullable=False, default=False)
    final_vp = Column(Integer, nullable=True)  # filled at game end
    is_winner = Column(Boolean, nullable=True)  # filled at game end

    __table_args__ = (
        ForeignKeyConstraint(["game_id"], ["card_clash_games.id"]),
    )


class GameEventRecord(Base):
    """Append-only analytics events."""

    __tablename__ = "card_clash_game_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Text, nullable=False)
    player_id = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)  # card_played, card_bought, tile_captured, etc.
    round_number = Column(Integer, nullable=False)
    card_id = Column(Text, nullable=True)  # base card ID
    card_name = Column(Text, nullable=True)
    detail_json = Column(Text, nullable=True)  # optional extra context
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        ForeignKeyConstraint(["game_id"], ["card_clash_games.id"]),
    )


class AggregateStatRecord(Base):
    """Incrementally updated counters for homepage stats widget."""

    __tablename__ = "card_clash_aggregate_stats"

    stat_key = Column(Text, primary_key=True)  # e.g. 'total_cards_played'
    stat_value = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), server_default=func.now())
