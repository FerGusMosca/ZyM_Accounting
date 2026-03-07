# common/config/settings.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, AliasChoices

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # ── App ───────────────────────────────────────────────────────────────────
    port: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PORT"))

    connection_string: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CONNECTION_STRING"))

    session_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SESSION_KEY"))

    # Customer name shown in the dashboard subtitle (CUSTOMER_NAME in .env)
    customer_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CUSTOMER_NAME"))

    # Product name shown in the title, sidebar and browser tab (PRODUCT_NAME in .env)
    product_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PRODUCT_NAME"))

    # ── Emisor (facturación) ──────────────────────────────────────────────────
    emisor_razon_social: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_RAZON_SOCIAL"))

    emisor_cuit: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_CUIT"))

    emisor_domicilio: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_DOMICILIO"))

    emisor_ib: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_IB"))

    emisor_inicio_act: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMISOR_INICIO_ACT"))

    # Valid values: RESP_MONOTR | RESP_INSCR
    emisor_cond_iva: str | None = Field(
        default="RESP_MONOTR",
        validation_alias=AliasChoices("EMISOR_COND_IVA"))

    # ── ARCA / AFIP ───────────────────────────────────────────────────────────
    # CUIT of the certificate holder (may differ from the commercial issuer).
    # Testing: your CUIT. Production: the CUIT that delegated in ARCA.
    arca_cuit: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_CUIT"))

    arca_cert_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_CERT_PATH"))

    arca_key_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("ARCA_KEY_PATH"))

    # "true" = homologación (testing)  |  "false" = producción
    arca_homo: str | None = Field(
        default="true",
        validation_alias=AliasChoices("ARCA_HOMO"))


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()