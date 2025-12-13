from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    app_name: str = 'Amaro Sport e Cultura'
    database_url: str = Field('sqlite:///./amaro.db', env='DATABASE_URL')
    static_path: str = Field('static', env='STATIC_PATH')
    nexipay_merchant_id: str | None = Field(None, env='NEXI_MERCHANT_ID')
    nexipay_api_key: str | None = Field(None, env='NEXI_API_KEY')
    membership_fee_eur: int = 50
    nexipay_endpoint: str = Field(
        'https://int-ecommerce.nexi.it/ecomm/api/checkout', env='NEXI_ENDPOINT'
    )
    nexipay_success_url: str = Field(
        'http://localhost:8000/tesseramento?success=1', env='NEXI_SUCCESS_URL'
    )
    nexipay_failure_url: str = Field(
        'http://localhost:8000/tesseramento?failed=1', env='NEXI_FAILURE_URL'
    )
    uploads_path: str = Field('uploads', env='UPLOAD_PATH')
    google_drive_api_key: str | None = Field(None, env='GOOGLE_DRIVE_API_KEY')
    drive_events_folder_id: str | None = Field(None, env='GOOGLE_DRIVE_EVENTS_FOLDER_ID')
    drive_gallery_folder_id: str | None = Field(None, env='GOOGLE_DRIVE_GALLERY_FOLDER_ID')
    session_secret: str = Field('change-me-session', env='SESSION_SECRET')

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


settings = Settings()
