from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    app_name: str = 'Amaro'
    database_url: str = Field('sqlite:///./amaro.db', env='DATABASE_URL')
    static_path: str = Field('static', env='STATIC_PATH')
    nexipay_merchant_id: str | None = Field(None, env='NEXI_MERCHANT_ID')
    nexipay_api_key: str | None = Field(None, env='NEXI_API_KEY')
    membership_fee_eur: int = 50
    nexipay_endpoint: str = Field(
        'https://int-ecommerce.nexi.it/ecomm/ecomm/DispatcherServlet',
        env='NEXI_ENDPOINT',
    )
    nexipay_success_url: str = Field(
        'http://127.0.0.1:8000/nexi/success',
        env='NEXI_SUCCESS_URL',
    )
    nexipay_failure_url: str = Field(
        'http://127.0.0.1:8000/nexi/failure',
        env='NEXI_FAILURE_URL',
    )
    # Notifica server-to-server (urlpost) per i tesseramenti; vuoto = dominio di NEXI_SUCCESS_URL + /nexi/notifica
    nexipay_notify_url: str | None = Field(None, env='NEXI_NOTIFY_URL')
    uploads_path: str = Field('uploads', env='UPLOAD_PATH')
    google_vision_api_key: str | None = Field(None, env='GOOGLE_VISION_API_KEY')
    session_secret: str = Field('change-me-session', env='SESSION_SECRET')
    admin_username: str | None = Field(None, env='ADMIN_USERNAME')
    admin_password: str | None = Field(None, env='ADMIN_PASSWORD')
    smtp_host: str | None = Field(None, env='SMTP_HOST')
    smtp_port: int = Field(587, env='SMTP_PORT')
    smtp_user: str | None = Field(None, env='SMTP_USER')
    smtp_password: str | None = Field(None, env='SMTP_PASSWORD')
    smtp_from: str | None = Field(None, env='SMTP_FROM')
    smtp_use_tls: bool = Field(True, env='SMTP_USE_TLS')
    smtp_use_ssl: bool = Field(False, env='SMTP_USE_SSL')
    privacy_policy_url: str | None = Field(None, env='PRIVACY_POLICY_URL')
    privacy_photo_url: str | None = Field(None, env='PRIVACY_PHOTO_URL')
    privacy_other_url: str | None = Field(None, env='PRIVACY_OTHER_URL')
    events_notify_email: str | None = Field(None, env='EVENTS_NOTIFY_EMAIL')
    membership_notify_email: str | None = Field(None, env='MEMBERSHIP_NOTIFY_EMAIL')
    acsi_notify_email: str | None = Field(None, env='ACSI_NOTIFY_EMAIL')
    medical_manual_review_email: str | None = Field(
        'amaro.bici@gmail.com', env='MEDICAL_MANUAL_REVIEW_EMAIL'
    )
    wattlab_download_url: str | None = Field(None, env='WATTLAB_DOWNLOAD_URL')
    wattlab_token_ttl_days: int = Field(30, env='WATTLAB_TOKEN_TTL_DAYS')
    wattlab_version: str = Field('0.1.0', env='WATTLAB_VERSION')
    wattlab_releases_dir: str = Field('releases/wattlab', env='WATTLAB_RELEASES_DIR')
    wattlab_installer_path: str | None = Field(None, env='WATTLAB_INSTALLER_PATH')
    wattlab_installer_filename: str = Field(
        'WattLab_0.1.0_x64-setup.exe',
        env='WATTLAB_INSTALLER_FILENAME',
    )
    app_public_url: str | None = Field(None, env='APP_PUBLIC_URL')
    companion_url: str = Field('https://companion.amarobici.it', env='COMPANION_URL')
    strava_client_id: str | None = Field(None, env='STRAVA_CLIENT_ID')
    strava_client_secret: str | None = Field(None, env='STRAVA_CLIENT_SECRET')
    anthropic_api_key: str | None = Field(None, env='ANTHROPIC_API_KEY')
    coach_model: str = Field('claude-haiku-5-5', env='COACH_MODEL')
    # Chiamate al modello per socio al giorno (un messaggio in chat ne usa 1-4).
    coach_daily_calls: int = Field(120, env='COACH_DAILY_CALLS')

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


settings = Settings()
