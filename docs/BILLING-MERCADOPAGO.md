# Mercado Pago — Dexter

## Precios y cupones
- Free: máximo acumulado 2 GiB (2,147,483,648 bytes).
- Premium mensual: $129 MXN/mes.
- Premium de por vida: $499 MXN pago único.
- DEXTERH4CK: $30 MXN menos en el primer cobro; para mensual, el webhook cambia la recurrencia a $129 MXN después de autorizar el ciclo inicial.
- LIAM-LIZ-FER-H4CK: activa Premium de por vida directamente; una redención por usuario.

## Variables Vercel
Configura en cada entorno que utilices: MP_ACCESS_TOKEN (privado), MP_WEBHOOK_SECRET, APP_BASE_URL (HTTPS canónica), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN. No pongas secretos en el frontend ni en GitHub.

Webhook: https://TU-DOMINIO/api/webhooks/mercadopago. Configura eventos payment y subscription_preapproval y copia el secreto de firma de Mercado Pago en MP_WEBHOOK_SECRET. El endpoint valida HMAC SHA-256 y consulta el recurso en la API antes de otorgar acceso.

## Seguridad
El ID de usuario se deriva del Bearer token Supabase, no del body. Los importes y cupones se validan en servidor. Los clientes solo pueden leer su propio entitlement/pedidos. Supabase es la fuente de verdad; Redis es caché secundaria. La función dexter_add_transferred_bytes incrementa el contador de forma atómica y rechaza cualquier operación que supere 2 GiB en plan free.
Usa credenciales de prueba y prueba pagos/webhooks antes de activar credenciales productivas. El webhook no autoriza borrar fotos ni declara verificadas las bibliotecas de Partner Sharing.
