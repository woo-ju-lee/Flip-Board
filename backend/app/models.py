from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class MatchCandidate(BaseModel):
    line_id: str | None
    segment_id: str
    distance_m: float
    verified: bool


class TrainLineMatch(BaseModel):
    status: Literal['matched', 'unknown', 'ambiguous'] = 'unknown'
    line_id: str | None = None
    segment_id: str | None = None
    distance_m: float | None = None
    confidence: float = 0
    reason: str = 'no_verified_geometry'
    candidates: list[MatchCandidate] = Field(default_factory=list)


class TrainPosition(BaseModel):
    id: str
    number: str
    kind: str
    origin: str
    destination: str
    planned_departure: datetime
    planned_arrival: datetime | None
    position_label: str
    coordinates: tuple[float, float]
    delay_minutes: float | None
    delay_status: Literal['unknown', 'on_time', 'delayed']
    received_at: datetime
    source_timestamp: datetime | None
    match: TrainLineMatch = Field(default_factory=TrainLineMatch)


class DataQuality(BaseModel):
    input_count: int = 0
    accepted_count: int = 0
    rejected_count: int = 0
    duplicate_count: int = 0
    conflicting_ids: int = 0
    reasons: dict[str, int] = Field(default_factory=dict)


class SourceStatus(BaseModel):
    source: Literal['live', 'archive']
    state: Literal['disabled', 'connecting', 'ok', 'stale', 'error', 'blocked', 'empty', 'archive', 'unverified_time']
    message: str
    freshness: Literal['fresh', 'stale', 'unknown', 'historical', 'none']
    last_received_at: datetime | None = None
    source_timestamp: datetime | None = None
    source_timestamp_kind: str = 'response_timestamp_not_individual_gps_time'
    source_age_seconds: float | None = None
    last_attempt_at: datetime | None = None
    next_attempt_at: datetime | None = None
    poll_seconds: float
    stale_after_seconds: float = 150
    consecutive_failures: int = 0
    error_code: str | None = None
    collection_enabled: bool
    geometry_available: bool
    quality: DataQuality = Field(default_factory=DataQuality)


class FilterInfo(BaseModel):
    station_id: str | None = None
    line_id: str | None = None
    state: Literal['all', 'ready', 'partial', 'unavailable', 'select_line', 'unmapped']
    message: str
    available_line_ids: list[str] = Field(default_factory=list)


class TrainResponse(BaseModel):
    trains: list[TrainPosition]
    count: int
    total_received: int
    unknown_count: int
    ambiguous_count: int
    status: SourceStatus
    filter: FilterInfo
