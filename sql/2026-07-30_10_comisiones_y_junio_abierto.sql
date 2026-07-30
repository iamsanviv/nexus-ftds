-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Comisiones confirmadas + junio abierto para corrección
-- 30 de julio de 2026
--
-- ESTADO: APLICADO EN PRODUCCIÓN. Los datos se corrieron con SQL directo; la
-- política es la migración `abrir_junio_2026_para_correccion_del_agente`.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1) COMISIONES CONFIRMADAS
--
-- Cierra el pendiente de «once productos en 0». Recordar que `comision = 0`
-- significaba SIN DEFINIR y esas ventas no sumaban: ya no queda ninguna así.
--
-- Esto NO toca las ventas ya registradas: la comisión se congela en la venta al
-- crearla, porque una comisión pactada no puede cambiar retroactivamente.
-- `productos` es el valor por defecto al crear, no la fuente de verdad de lo ya
-- vendido. Se comprobó antes de correrlo: 0 ventas con comisión sin definir, así
-- que no había nada que rellenar hacia atrás.
-- ───────────────────────────────────────────────────────────────────────────

update public.productos set comision = v.c from (values
  ('vip_promo',      55),   -- $220
  ('vip',            75),   -- $300
  ('platino_promo', 110),   -- $439  (antes 100)
  ('platino',       137),   -- $550
  ('oro_promo',     219),   -- $789  (antes 200)
  ('oro',           257),   -- $900
  ('trader_vip',     50)    -- $270
) as v(id, c) where productos.id = v.id;

-- Los bots comisionan exactamente el 30 %. Se guarda el MONTO y no el
-- porcentaje porque el modelo entero es de monto fijo congelado en la venta;
-- meter un porcentaje sería una segunda forma de calcular lo mismo.
--
-- CONSECUENCIA A RECORDAR: si cambia el precio de un bot, la comisión NO se
-- recalcula sola. Hay que volver a correr este update.
update public.productos
   set comision = round(precio * 0.30, 2)
 where categoria = 'bot';

-- Queda pendiente `parametros.comision_upgrade`, todavía en 0.


-- ───────────────────────────────────────────────────────────────────────────
-- 2) JUNIO 2026, ABIERTO PARA QUE CADA AGENTE CORRIJA LO SUYO
--
-- La regla general no cambia: un mes cerrado no se reabre, lo que se pagó se
-- pagó. Pero varios agentes entraron a junio con una BASE mal puesta —los FTD
-- que ya traían acumulados de antes— y esa base, al cerrarse el mes, sembró la
-- de julio. El error sigue vivo en el mes en curso. Se abre un periodo concreto
-- para que lo arreglen ellos mismos.
--
-- Lo que se corrige es SOLO `base`. Los `declarado` de junio no se tocan: ese
-- mes está cerrado y pagado. La pantalla ni siquiera los ofrece como campo.
--
-- El periodo va ESCRITO en la política, en vez de una columna «editable» o un
-- parámetro configurable: así la excepción no se puede extender sin tocar el
-- RLS y quedar en el historial de migraciones. Cuando junio esté cuadrado se
-- quita de acá y de la constante `PERIODO_ABIERTO` en `ftd.js`.
--
-- Lo que NO se relajó: sigue siendo `puede_ver_de(owner_id)`. Abrir el mes no
-- le abre a nadie las cifras de otro.
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists "ftd_base_upd" on public.ftd_base;

create policy "ftd_base_upd" on public.ftd_base
  for update
  using (
    public.puede_ver_de(owner_id)
    and (
      not cerrado                    -- lo normal: el mes en curso
      or public.es_admin()           -- el admin siempre pudo
      or periodo = '2026-06'         -- la excepción, acotada a este mes
    )
  )
  with check (public.puede_ver_de(owner_id));


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICADO simulando la sesión de una agente (Majo), en transacción revertida
--
--   corrige SU junio cerrado           pudo ✓
--   toca su MAYO cerrado               bloqueado ✓   ← la excepción es solo junio
--   toca el junio de OTRO agente       bloqueado ✓   ← sigue sin ver lo ajeno
--   ajusta su julio abierto            pudo ✓        ← no se rompió lo de siempre
--
-- Los dos del medio son los que importan: se abrió UN mes, no la puerta.
-- ───────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- ANEXO · Invitación propia por actividad + historial agrupado
-- (migración `mensaje_de_invitacion_propio_por_actividad`)
-- ═══════════════════════════════════════════════════════════════════════════

-- Las plantillas de `plantillas_seguimiento` son del AGENTE y valen para todo
-- lo que programa. Un lanzamiento suele necesitar su propio texto, y cambiarle
-- la plantilla para una sola actividad le rompería las demás. Nulo = usar la
-- del agente. Solo la INVITACIÓN: los recordatorios, el enlace y la
-- confirmación son iguales en todas partes.
alter table public.actividades
  add column if not exists msg_invitacion text;

-- El historial de invitados se unifica por `definicion->>'clave'`
-- (`act:<actividad_id>` o `cam:<campana_id>`) en vez de apilar una entrada por
-- tanda: el agente programa de a poquitos según le confirman, y así una sola
-- actividad se comía el historial con versiones incompletas de la misma lista.
create index if not exists segmentos_clave_idx
  on public.segmentos ((definicion ->> 'clave'))
  where definicion ->> 'clave' is not null;

-- Comprobado en transacción revertida: dos tandas sobre la misma clave dejan
-- UNA entrada con la unión de las personas (5 de 3+3 con una repetida), y la
-- política `segmentos_upd` (owner_id = auth.uid()) cubre la fusión — se revisó
-- antes de escribir el update, porque sin política habría fallado en silencio.


-- ═══════════════════════════════════════════════════════════════════════════
-- ANEXO 2 · El rastreo se decide al programar, no al crear la actividad
-- (migración `quitar_actividades_rastrear_la_decision_es_por_tanda`)
-- ═══════════════════════════════════════════════════════════════════════════

-- A una lista de confianza se le rastrea y a un público frío se le manda el
-- zoom.us tal cual, y la misma actividad puede querer las dos cosas en tandas
-- distintas. La casilla se movió al bloque de programación.
--
-- Con eso `actividades.rastrear` deja de tener sentido: la verdad de quién
-- lleva enlace rastreado ya está escrita persona por persona en si su
-- seguimiento tiene `clic_token`. Se comprobó antes de quitarla que las 35
-- filas estuvieran en `true` — nadie la apagó nunca, así que no había ninguna
-- decisión guardada que perder.
--
-- Se ELIMINA en vez de dejarla sin uso: una columna muerta que sigue ahí es
-- exactamente la trampa de `mensajes_programados.imagen_url`.
alter table public.actividades drop column if exists rastrear;


-- ═══════════════════════════════════════════════════════════════════════════
-- ANEXO 3 · El bucket `mensajes` acepta video (31/07)
-- (migración `bucket_mensajes_acepta_video_y_sube_a_16mb`)
-- ═══════════════════════════════════════════════════════════════════════════

-- Los videos se rechazaban por DOS motivos y solo se veía el primero:
--   1. `allowed_mime_types` no tenía video/mp4 ni video/quicktime. El único
--      video permitido era webm, y estaba ahí por la grabación de notas de voz.
--      De ahí el «mime type video/quicktime is not supported» con un .mov.
--   2. `file_size_limit` era 10 MB mientras la pantalla ofrecía 16. El archivo
--      de la prueba pesaba 9 MB, así que ese tope no llegó a saltar — habría
--      aparecido después, con otro error, pareciendo un problema nuevo.
--
-- LECCIÓN: el `accept` del input, `TIPOS_OK` en masivo.js y este
-- `allowed_mime_types` son tres sitios que describen la misma regla.
update storage.buckets
   set allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif',
         'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/x-m4a',
         'video/webm', 'video/mp4', 'video/quicktime'
       ],
       file_size_limit = 16 * 1024 * 1024
 where id = 'mensajes';
