-- =====================================================================
--  canales_wa.comando_en — que una orden de desvincular caduque
--  Aplicado el 2026-08-27 con el MCP de Supabase.
-- =====================================================================
--
--  EL DEFECTO
--
--  `comando` es cómo el panel le habla al bridge («desvincular»). El bridge
--  la consume y la borra. Pero si el bridge NO la consume —porque está caído,
--  o porque es una versión que no lee esa columna— la orden **se queda viva
--  para siempre**.
--
--  Dos consecuencias, las dos vistas en producción el 26/08/2026:
--
--  1. El agente pulsa «Desvincular», no pasa nada, y el panel vuelve a
--     mostrar «Vinculado» sin explicar por qué. Parece que el botón miente.
--
--  2. Peor: la orden vieja detona MUCHO DESPUÉS. Santiago Viveros llevaba un
--     «desvincular» encolado desde días atrás; al migrarlo a un bridge que sí
--     lee la columna, el bridge se emparejó a las 00:39:34 y **cuatro segundos
--     más tarde** consumió esa orden y cerró la sesión recién creada.
--
--  Una orden sin fecha no se puede caducar, y sin caducar no hay forma de
--  distinguir «esto se acaba de pedir» de «esto lleva una semana ahí».
--
--  POR QUÉ UN TRIGGER Y NO UNA COLUMNA QUE ESCRIBA EL PANEL
--
--  `authenticated` tiene UPDATE sobre UNA sola columna: `comando`. Ese grant
--  estrecho es deliberado. Dejar que el panel escriba también la fecha
--  obligaría a ampliarlo y permitiría antedatar una orden para que pareciera
--  fresca. El trigger la sella del lado del servidor: el agente sigue
--  escribiendo solo `comando` y la fecha no se puede falsificar.
-- =====================================================================

alter table public.canales_wa
  add column if not exists comando_en timestamptz;

comment on column public.canales_wa.comando_en is
  'Cuándo se pidió el comando pendiente. La sella un trigger; nadie la escribe a mano. NULL = sin comando. Sirve para caducar órdenes que ningún bridge recogió.';

create or replace function public.sellar_comando_canal()
returns trigger
language plpgsql
as $$
begin
  -- Solo al CAMBIAR el comando: un latido del bridge que reescribe otras
  -- columnas no debe refrescar la fecha y hacer eterna una orden vieja.
  if new.comando is distinct from old.comando then
    new.comando_en := case when new.comando is null then null else now() end;
  end if;
  return new;
end
$$;

drop trigger if exists canales_wa_sella_comando on public.canales_wa;
create trigger canales_wa_sella_comando
  before update on public.canales_wa
  for each row
  execute function public.sellar_comando_canal();

-- Las órdenes que ya estaban encoladas cuando se creó la columna no tienen
-- fecha y nunca caducarían. No hay forma de saber cuándo se pidieron, y una
-- orden de origen desconocido es justo la que no queremos que detone: se
-- limpian.
update public.canales_wa
   set comando = null
 where comando is not null
   and comando_en is null;
