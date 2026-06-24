from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    app_name: str = 'Amaro'
    database_url: str = Field('sqlite:///./amaro.db', env='DATABASE_URL')
    static_path: str = Field('static', env='STATIC_PATH')
    nexipay_merchant_id: str | None = Field(None, env='NEXI_MERCHANT_ID')
    nexipay_api_key: str | None = Field(None, env='NEXI_API_KEY')
    membership_fee_eur: int = 50
    nexipay_endpoint: str = Field(..., env='NEXI_ENDPOINT')
    nexipay_success_url: str = Field(..., env='NEXI_SUCCESS_URL')
    nexipay_failure_url: str = Field(..., env='NEXI_FAILURE_URL')
    uploads_path: str = Field('uploads', env='UPLOAD_PATH')
    google_vision_api_key: str | None = Field(None, env='GOOGLE_VISION_API_KEY')
    google_drive_api_key: str | None = Field(None, env='GOOGLE_DRIVE_API_KEY')
    drive_events_folder_id: str | None = Field(None, env='GOOGLE_DRIVE_EVENTS_FOLDER_ID')
    drive_gallery_folder_id: str | None = Field(None, env='GOOGLE_DRIVE_GALLERY_FOLDER_ID')
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

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


settings = Settings()
