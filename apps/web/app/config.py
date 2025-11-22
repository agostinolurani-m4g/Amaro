from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    app_name: str = 'Amaro Sport e Cultura'
    database_url: str = Field('sqlite:///./amaro.db', env='DATABASE_URL')
    static_path: str = Field('static', env='STATIC_PATH')
    nexipay_merchant_id: str | None = Field(None, env='NEXI_MERCHANT_ID')
    nexipay_api_key: str | None = Field(None, env='NEXI_API_KEY')
    membership_fee_eur: int = 25
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

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


settings = Settings()
