/// <reference types="vite/client" />



interface ImportMetaEnv {

  readonly VITE_AMARO_API_URL?: string;

  readonly VITE_AMARO_DOWNLOAD_URL?: string;

}



interface ImportMeta {

  readonly env: ImportMetaEnv;

}


