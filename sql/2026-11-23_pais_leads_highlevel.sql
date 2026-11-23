-- 23/11/2026 · Relleno único: país por indicativo para las personas que
-- llegaron desde HighLevel (fila en crm_leads) y no tenían país.
-- Mismo criterio que `paisDeTel` en supabase/functions/highlevel-lead/index.ts:
-- teléfono con «+», 10–15 dígitos, prefijo más largo gana, «+1» a secas no.
-- Colombia pone además tz_offset_min = 0 si estaba vacío.
-- Las filas tocadas quedan en `_respaldo_pais_hl_20261123` para poder revertir:
--   update clientes c set pais = null, tz_offset_min = r.tz_antes
--   from _respaldo_pais_hl_20261123 r where r.id = c.id;
create table if not exists _respaldo_pais_hl_20261123 (id uuid primary key, pais_nuevo text, tz_antes int);
alter table _respaldo_pais_hl_20261123 enable row level security;

with pref(p, pais) as (values
  ('1809','República Dominicana'),('1829','República Dominicana'),('1849','República Dominicana'),
  ('1787','Puerto Rico'),('1939','Puerto Rico'),
  ('501','Belice'),('502','Guatemala'),('503','El Salvador'),('504','Honduras'),
  ('505','Nicaragua'),('506','Costa Rica'),('507','Panamá'),('509','Haití'),
  ('591','Bolivia'),('593','Ecuador'),('595','Paraguay'),('598','Uruguay'),('351','Portugal'),
  ('33','Francia'),('34','España'),('39','Italia'),('44','Reino Unido'),('49','Alemania'),
  ('51','Perú'),('52','México'),('53','Cuba'),('54','Argentina'),('55','Brasil'),
  ('56','Chile'),('57','Colombia'),('58','Venezuela')),
cand as (
  select distinct on (c.id) c.id, p.pais, c.tz_offset_min tz_antes
  from clientes c
  join crm_leads l on l.cliente_id = c.id
  join pref p on regexp_replace(c.telefono, '\D', '', 'g') like p.p || '%'
  where coalesce(c.pais, '') = ''
    and btrim(c.telefono) like '+%'
    and length(regexp_replace(c.telefono, '\D', '', 'g')) between 10 and 15
  order by c.id, length(p.p) desc),
resp as (
  insert into _respaldo_pais_hl_20261123 select id, pais, tz_antes from cand
  on conflict do nothing returning id)
update clientes c
set pais = cand.pais,
    tz_offset_min = case when cand.pais = 'Colombia' then coalesce(c.tz_offset_min, 0) else c.tz_offset_min end
from cand where cand.id = c.id;
