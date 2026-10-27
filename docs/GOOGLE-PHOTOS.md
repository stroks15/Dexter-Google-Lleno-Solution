# Google Photos: Partner Sharing sin intermediación binaria

## Arquitectura
- Vercel sirve la interfaz estática y endpoints ligeros de autenticación, metadatos y estado.
- Ninguna ruta descarga, bufferiza, fragmenta o sube archivos binarios.
- La aplicación no usa Picker API para copiar medios ni Photos Library API para subirlos.
- El usuario invita la Cuenta 2 desde Partner Sharing de la Cuenta 1; acepta en la Cuenta 2 y activa Guardar en tu cuenta → Todas las fotos, si quiere guardar todo lo compartido.
- La aplicación registra el proceso, pero no puede configurar Partner Sharing ni verificar la biblioteca completa por API.

## Verificación y borrado
La API pública de Google Photos no proporciona un inventario completo de ambas bibliotecas que permita verificar una copia exacta de cada elemento. Nombre, tamaño y fecha no prueban identidad binaria. El endpoint de verificación devuelve MANUAL_VERIFICATION_REQUIRED, verified=false y safeToDelete=false. Nunca declara SAFE_TO_DELETE ni habilita borrado automático.

Google indica que los elementos guardados antes de que el colaborador elimine los originales permanecen en la biblioteca destino. Sin embargo, no cuentan contra la cuota del destino mientras el origen continúe compartiéndolos. Partner Sharing no debe describirse como una copia independiente que siempre libera cuota de destino.

## Rutas
- POST /api/migrations/partner-sharing: crea registro del proceso.
- POST /api/migrations/verify con jobId: registra revisión manual; no verifica ni autoriza borrado.
- GET /api/migrations/scan: lista metadatos de Drive únicamente. service=photos responde que se requiere Partner Sharing.
- GET /api/migrations/progress: lectura del estado del trabajo.

La eliminación de originales de Google Fotos es siempre manual y queda fuera de esta aplicación.
