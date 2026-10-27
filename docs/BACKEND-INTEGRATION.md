# Backend de metadatos y Partner Sharing

## Rutas conservadas
- POST /api/auth/google: genera una URL OAuth con estado de un solo uso.
- GET /api/auth/callback/google: valida identidad, cifra refresh tokens y guarda credenciales en Supabase.
- GET /api/auth/connections: devuelve metadatos de conexión seguros.
- GET /api/migrations/scan: enumera metadatos de Google Drive. service=photos devuelve MANUAL_VERIFICATION_REQUIRED.
- POST /api/migrations/partner-sharing: registra el flujo nativo de Partner Sharing en Supabase.
- POST /api/migrations/verify: devuelve MANUAL_VERIFICATION_REQUIRED y safeToDelete=false.
- GET /api/migrations/progress: consulta el estado del registro.
- GET /api/config y GET /api/health: configuración pública y readiness de presencia de variables.

## Rutas eliminadas
Se eliminaron el worker de transferencia, el lector/bufferizador de Google Photos, la cola de transferencias binarias y las rutas de borrado automático. Ninguna API conserva un flujo de descarga/subida de archivos.

## Límite de Google Photos
Partner Sharing lo configura el usuario en Google Fotos. La API pública no ofrece un inventario completo de las dos bibliotecas para verificar cada medio de forma independiente. Coincidir en nombre, tamaño y fecha no prueba igualdad del contenido; la app nunca emite SAFE_TO_DELETE ni elimina medios.

## Variables
Mantén en el proveedor las variables de Supabase, OAuth, cifrado de tokens y Upstash Redis para el estado OAuth. QSTASH_TOKEN y WORKER_SHARED_SECRET ya no son necesarios para este proyecto. No expongas secretos al frontend.
