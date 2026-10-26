from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DATA_DIR = Path(__file__).resolve().parents[1] / 'data'


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='KORAIL_', env_file='.env', extra='ignore')

    live_enabled: bool = False
    usage_policy_reference: str = ''
    poll_seconds: float = Field(default=60, ge=60)
    timeout_seconds: float = Field(default=15, ge=1, le=60)
    stale_seconds: float = Field(default=150, ge=1)
    max_backoff_seconds: float = Field(default=900, ge=60)
    match_distance_meters: float = Field(default=70, gt=0, le=500)
    ambiguity_meters: float = Field(default=35, ge=0)
    min_confidence: float = Field(default=0.65, ge=0, le=1)
    switch_confirmations: int = Field(default=2, ge=1, le=10)
    max_speed_meters_per_second: float = Field(default=120, gt=0)
    data_dir: Path = DATA_DIR

    @model_validator(mode='after')
    def validate_intervals(self):
        if self.max_backoff_seconds < self.poll_seconds:
            raise ValueError('max_backoff_seconds must be >= poll_seconds')
        return self

    @property
    def collection_allowed(self) -> bool:
        return self.live_enabled
