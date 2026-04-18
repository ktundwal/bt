// Carnage Courts runtime configuration.
//
// This file is a placeholder in the committed repo. At deploy time, the
// GitHub Actions workflow overwrites it with real values from repository
// secrets before uploading the Pages artifact. The deployed copy is still
// readable from the browser — static sites can't hide credentials — but
// the committed copy stays clean of tokens, keeping git history tidy and
// avoiding secret-scanner flags.
//
// For local development, leave these empty (local-only mode; changes
// won't sync across devices) or paste real values temporarily. Don't
// commit real values back into this file.

export const UPSTASH_REDIS_REST_URL = ''
export const UPSTASH_REDIS_REST_TOKEN = ''
