-- =====================================================================
--  Aviso de `comando` por LISTEN/NOTIFY — dejar de sondear
--  Aplicado el 2026-10-02 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  El bridge de cada agente preguntaba a la base «¿hay una orden para mí?»
--  cada ~2 s, todo el día: ~40.000 peticiones diarias por agente para recibir
--  una orden («desvincular») que llega unas pocas veces al mes. Ese sondeo
--  en vacío era el 77% del egress y lo que agotó el cupo del plan gratis.
--
--  En vez de que la VM pregunte, la base AVISA: un trigger emite un
--  `pg_notify` en el instante en que se escribe una orden. El bridge mantiene
--  una conexión que escucha ese canal y reacciona al aviso. Deja de preguntar.
--
--  POR QUÉ UN TRIGGER PROPIO Y NO AMPLIAR `sellar_comando_canal`
--
--  Son dos responsabilidades distintas: sellar la fecha (BEFORE, muta la fila)
--  y avisar (AFTER, efecto externo). Separarlas deja revertir el aviso sin
--  tocar el sellado, y mantiene cada función legible. El aviso es AFTER porque
--  solo tiene sentido una vez que el cambio quedó firme.
--
--  POR QUÉ NO UNA TABLA NUEVA
--
--  Con NOTIFY el «canal dedicado» es el propio canal de Postgres, y el trigger
--  controla con exactitud cuándo avisar: SOLO cuando `comando` cambia a un
--  valor real. El latido del bridge (que reescribe `actualizado`) nunca
--  dispara un aviso. No hay que mover la columna ni cambiar cómo escribe el
--  panel; `authenticated` sigue con UPDATE solo sobre `comando`.
--
--  ADITIVO Y REVERSIBLE
--
--  Nada depende todavía de este aviso: el bridge sigue sondeando como hoy.
--  Esto solo AÑADE la señal. Quitar el trigger y la función devuelve la base
--  a su estado exacto anterior. El corte del sondeo va en una fase posterior,
--  cuando el bridge ya sepa escuchar.
--
--  EL CANAL Y SU CARGA
--
--  Canal:  canal_comando
--  Carga:  JSON { owner_id, comando, host }  (diminuto; muy por debajo del
--          tope de 8000 bytes de NOTIFY). `owner_id` deja que cada bridge
--          filtre lo suyo; `host` permite, más adelante, que un único
--          escucha enrute a la máquina correcta sin volver a consultar.
-- =====================================================================

create or replace function public.avisar_comando_canal()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- Solo cuando aparece una orden real. En UPDATE exige que CAMBIE respecto a
  -- la anterior (un latido que reescribe otras columnas no avisa); en INSERT
  -- basta que venga con comando (caso raro, pero no se escapa).
  if new.comando is not null
     and (tg_op = 'INSERT' or new.comando is distinct from old.comando) then
    perform pg_notify(
      'canal_comando',
      json_build_object(
        'owner_id', new.owner_id,
        'comando',  new.comando,
        'host',     new.host
      )::text
    );
  end if;
  return null;  -- AFTER trigger: el valor de retorno se ignora.
end
$$;

drop trigger if exists canales_wa_avisa_comando on public.canales_wa;
create trigger canales_wa_avisa_comando
  after insert or update on public.canales_wa
  for each row
  execute function public.avisar_comando_canal();

comment on function public.avisar_comando_canal() is
  'Emite NOTIFY en el canal canal_comando cuando aparece una orden en canales_wa.comando. Reemplaza el sondeo del bridge. Aditivo: el sondeo sigue sirviendo de respaldo hasta que el bridge escuche.';

-- ---------------------------------------------------------------------
--  AL REAPLICAR: `create trigger` necesita SHARE ROW EXCLUSIVE sobre
--  canales_wa, que choca con cada escritura (ROW EXCLUSIVE). Con los bridges
--  vivos (latido cada 30 s + sondeo cada 2 s) el DDL se queda esperando y
--  expira. Se creó el 2026-10-02 con producción detenida y entró al instante.
--  Si hay que rehacerlo en caliente: ventana sin escrituras, o
--  `set lock_timeout` + reintentos hasta pillar un hueco. La función (que no
--  bloquea la tabla) sí se puede crear en cualquier momento.
-- ---------------------------------------------------------------------
