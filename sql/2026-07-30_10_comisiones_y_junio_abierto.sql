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
-- pagó. Pero junio quedó con cifras malas en varios agentes y esas cifras
-- SEMBRARON LA BASE DE JULIO al cerrarse, así que el error sigue vivo en el mes
-- en curso. Se abre un periodo concreto para que lo arreglen ellos mismos.
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
