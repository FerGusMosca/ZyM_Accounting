# common/config/settings.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, AliasChoices

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # SESSION_KEY
    port: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PORT", "PORT"))

    connection_string: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CONNECTION_STRING", "CONNECTION_STRING"))

    session_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SESSION_KEY", "SESSION_KEY"))

    # ── Emisor (facturación) ──────────────────────────────────────────────────
    emisor_razon_social: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_RAZON_SOCIAL", "EMISOR_RAZON_SOCIAL"))

    emisor_cuit: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_CUIT", "EMISOR_CUIT"))

    emisor_domicilio: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_DOMICILIO", "EMISOR_DOMICILIO"))

    emisor_ib: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_IB", "EMISOR_IB"))

    emisor_inicio_act: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_INICIO_ACT", "EMISOR_INICIO_ACT"))

    # Valores válidos: RESP_MONOTR | RESP_INSCR
    emisor_cond_iva: str | None = Field(
        default="RESP_MONOTR",
        validation_alias=AliasChoices("EMISOR_COND_IVA", "EMISOR_COND_IVA"))

    # ── ARCA / AFIP ───────────────────────────────────────────────────────────
    # CUIT titular del certificado (puede ser distinto al emisor comercial).
    # Testing: tu CUIT. Producción: el CUIT que hizo la delegación en ARCA.
    arca_cuit: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_CUIT", "ARCA_CUIT"))

    arca_cert_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_CERT_PATH", "ARCA_CERT_PATH"))

    arca_key_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_KEY_PATH", "ARCA_KEY_PATH"))

    # "true" = homologación (testing)  |  "false" = producción
    arca_homo: str | None = Field(
        default="true",
        validation_alias=AliasChoices("ARCA_HOMO", "ARCA_HOMO"))


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()