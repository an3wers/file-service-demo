/// <reference types="vite/client" />

// Никаких import/export в этом файле: любой из них сделает объявление модульным,
// и `ImportMetaEnv` перестанет сливаться с типом из `vite/client`.
interface ImportMetaEnv {
  readonly VITE_API_KEY: string;
  readonly VITE_S3_HOST: string;
  readonly VITE_MAX_UPLOAD_SIZE_MB?: string;
}
