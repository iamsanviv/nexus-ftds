-- Precios del Bot GoPro (lista del dueño, 31/08/2026)
--
-- POR QUÉ: la familia GoPro tenía solo dos precios cargados (anual 415 y
-- vitalicio 615) y en la práctica se vende con siete. Lo que faltaba se
-- registraba con «Otro (a mano)», que no trae comisión: cada venta de esas
-- salía con comision = 0, y `comision = 0` significa SIN DEFINIR, así que la
-- venta no sumaba a la comisión del mes. Cargarlos es lo que hace que el
-- panel cuadre solo.
--
-- COMISIÓN: 25 % del precio en TODOS los GoPro, dicho por el dueño. Se guarda
-- el MONTO, no el porcentaje, igual que el resto del catálogo: `productos` es
-- el valor por defecto al CREAR una venta, no la fuente de verdad de lo ya
-- vendido (la venta congela precio y comisión). Ojo con la trampa de siempre:
-- si cambia el precio de uno de estos hay que recalcular la comisión a mano.
--
-- OJO — el 30 % de los bots ya no es regla general. Bot IA, GoTraders y Gold
-- siguen al 30 %; toda la familia GoPro va al 25 %.
--
-- Dos de los siete YA existían con el precio y la comisión correctos
-- (gopro_anual 415/103.75 y gopro_vit 615/153.75) y no se tocaron.

insert into productos (id, nombre, categoria, precio, comision, nivel, orden, activo) values
  ('gopro_promo',       'Bot GoPro (Promo)',                             'bot', 399.00,  99.75, null, 44, true),
  ('gopro_anual_full',  'Bot GoPro (Anual, precio full)',                'bot', 499.00, 124.75, null, 46, true),
  ('gopro_vit_vipdf',   'Bot GoPro (Vitalicio) + Grupo VIP Diego Facundo','bot', 735.00, 183.75, null, 48, true),
  ('vipdf_gopro_promo', 'VIP Diego Facundo BotGoPro (Promo)',            'bot', 320.00,  80.00, null, 49, true),
  ('vipdf_gopro',       'VIP Diego Facundo BotGoPro',                    'bot', 445.00, 111.25, null, 50, true);

-- Renumerado del bloque de bots para que la familia GoPro quede CONTIGUA y en
-- orden de precio dentro del selector. `orden` es solo presentación (data.js
-- carga con .order("orden") y pintarProductos agrupa por categoría), así que
-- no afecta a ninguna venta ya registrada. Tampoco importa que un `orden`
-- coincida con el de otra categoría: nunca se comparan entre grupos.
update productos as p set orden = v.orden
from (values
  ('gopro_vip',       43),   -- 135, «Servicios VIP»
  ('gopro_anual',     45),   -- 415
  ('gopro_vit',       47),   -- 615
  ('gotraders_anual', 51),
  ('gotraders_vit',   52),
  ('gold_anual',      53),
  ('gold_vit',        54)
) as v(id, orden)
where p.id = v.id;

-- COMPROBADO tras aplicar: los siete precios del dueño están, la familia
-- GoPro va contigua de orden 43 a 50 y los siete dan exactamente 25.00 % al
-- dividir comision/precio.
--
-- PENDIENTE (no se tocó, hace falta que lo decida el dueño):
-- `gopro_vip` («Bot GoPro (Servicios VIP)», $135) sigue al 30 % — 40.50. Es un
-- GoPro, pero NO está en la lista de siete, así que no se le aplicó el 25 %
-- por cuenta propia. Al 25 % serían 33.75.
