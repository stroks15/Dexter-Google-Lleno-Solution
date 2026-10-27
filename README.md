# Dexter Google Lleno Solution

Aplicación mobile-first para guiar la liberación de espacio mediante Partner Sharing nativo de Google Fotos, con autenticación y registro ligero de estado.

## Arquitectura
No hay transferencia de archivos por Vercel. Los endpoints conservados manejan autenticación, metadatos ligeros y estado; no descargan, bufferizan, fragmentan ni suben fotos o videos. La sincronización de Google Fotos se configura en la propia interfaz de Google.

## Seguridad y límites
- OAuth y secretos permanecen en el servidor.
- Partner Sharing debe configurarse manualmente desde la Cuenta 1 y aceptarse/guardarse desde la Cuenta 2.
- La API no ofrece un inventario completo de ambas bibliotecas que permita garantizar igualdad de todos los elementos. Nombre, tamaño y fecha no prueban igualdad binaria.
- La verificación falla de forma segura: MANUAL_VERIFICATION_REQUIRED, verified=false y safeToDelete=false. Nunca declara SAFE_TO_DELETE ni borra fotos.
- Google indica que los elementos guardados antes de que el origen los elimine permanecen en destino; no cuentan contra la cuota del destino mientras el origen siga compartiéndolos.
- Se pueden listar metadatos de Drive, pero esta app no copia ni elimina archivos de Drive.

## Estructura
- src/: frontend estático.
- api/: autenticación, metadatos y estado ligero únicamente.
- supabase/migrations/: esquema aislado bajo dexter_google_*.
- vercel.json: archivos estáticos y headers de seguridad.

## Variables de entorno
Configura secretos únicamente en el proveedor: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY, UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN. No publiques valores secretos.

## Verificación local
npm run build valida configuración y sintaxis JavaScript. No equivale a una prueba end-to-end con cuentas reales de Google.
