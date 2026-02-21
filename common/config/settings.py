# common/config/settings.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, AliasChoices

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    #SESSION_KEY


    port: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PORT", "PORT"))


    connection_string: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CONNECTION_STRING", "CONNECTION_STRING"))


    session_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SESSION_KEY", "SESSION_KEY"))





@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
