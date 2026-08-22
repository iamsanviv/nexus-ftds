-- Bot GoPro (Anual) y (Vitalicio) pasan a comisionar 25%
--
-- Los dos productos YA EXISTÍAN con el precio correcto (415 y 615) y comisión
-- del 30%, que es la de todos los bots del catálogo. Se piden al 25%:
--
--   Bot GoPro (Anual)      415  ->  103.75
--   Bot GoPro (Vitalicio)  615  ->  153.75
--
-- Quedan como los dos únicos bots por debajo del 30%. Es deliberado, decidido
-- el 21/08/2026; los otros siete se quedan como estaban.
--
-- El catálogo es solo el VALOR POR DEFECTO de las ventas nuevas: la comisión se
-- congela en la venta al crearla, así que esto no toca nada ya causado. Además,
-- ninguno de los dos tenía ventas registradas al momento del cambio.

update public.productos
   set comision = round(precio * 0.25, 2)
 where id in ('gopro_anual', 'gopro_vit');
