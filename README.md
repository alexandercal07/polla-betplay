# Polla BetPlay — Liga Dimayor en vivo + apuestas entre amigos

Tiene tres vistas: **Partidos** (lista por fecha al estilo 365Scores, con filtros En vivo, Próximos, Resultados y Mis apuestas), **Detalle del partido** (resumen minuto a minuto, alineaciones en cancha, estadísticas y apuesta) y **Mis pollas** (leaderboard, apuestas rápidas, invitar amigos y configuración). También tiene una pestaña de **Posiciones**.

## Arquitectura
- Frontend: `index.html`, `app.js` y `styles.css`, sin dependencias ni proceso de build.
- `/api/espn`: proxy hacia la API pública (no oficial) de ESPN para la liga `col.1`. Guarda las respuestas en caché entre 15 y 20 s en el CDN de Vercel, así que aunque haya muchos amigos conectados se hacen pocas llamadas a ESPN.
- `/api/groups`, `/api/bets` y `/api/leaderboard`: la lógica de la polla, que corre en el servidor.
- Supabase (Postgres): guarda grupos, miembros y apuestas. La seguridad a nivel de fila (RLS) está activada sin políticas, así que solo las funciones de `/api` pueden leer y escribir.

## Reglas implementadas
- Marcador exacto: **3 pts**. Acertar ganador o empate sin el marcador exacto: **1 pt**. Ambos valores se pueden cambiar por polla.
- Las apuestas se cierran al pitazo inicial. **El servidor lo valida consultando a ESPN**, así que no sirve de nada manipular el navegador.
- Las apuestas de los demás quedan ocultas hasta que empieza el partido.
- Los partidos aplazados o cancelados no cuentan. Los penales tampoco: se usa el marcador del partido.
- Quien crea la polla puede cambiar el nombre, los puntos y la fecha desde la que cuentan los partidos.

## Despliegue (unos 15 minutos, gratis)
1. **Supabase**: crea un proyecto en supabase.com. Ve a SQL Editor, pega el contenido de `supabase/schema.sql` y dale Run.
2. En Supabase, entra a Project Settings → API y copia la **Project URL** y la llave **Secret key** (sb_secret_…, en API Keys) o la legacy service_role. Esa llave es secreta: no la pongas nunca en el frontend.
3. **Vercel**: sube esta carpeta a un repositorio de GitHub. Luego, en vercel.com, crea un proyecto nuevo, importa el repo y dale Deploy. No necesita framework ni comando de build.
4. En Vercel, ve a Settings → Environment Variables y agrega:
   - `SUPABASE_URL` = la Project URL
   - `SUPABASE_SERVICE_KEY` = la llave service_role

   Después haz Redeploy.
5. Abre el sitio, ve a **Mis pollas**, crea la polla y comparte el link de invitación.

Para probarlo en local: `npm i -g vercel`, luego `vercel dev`, con las mismas variables guardadas en un archivo `.env`.

## Riesgos conocidos
- **ESPN no es una API oficial.** Puede cambiar o bloquear las peticiones sin aviso. Si eso pasa, solo hay que reescribir `api/espn.js` (y `parseEvent` en `app.js`) para usar otra fuente, por ejemplo API-Football con clave.
- Qué tan completos vienen los datos (alineaciones, estadísticas, grupos de cuadrangulares) depende de lo que ESPN publique para la Liga BetPlay. Cuando falta algo, la interfaz lo dice en vez de romperse.
- Acceso con link + código: cada persona recibe una llave personal que queda guardada en su navegador. Si cambia de dispositivo, tiene que pegar esa llave en "Entrar con tu llave personal".
