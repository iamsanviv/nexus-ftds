-- Retirar «Bot GoPro (Servicios VIP)» ($135) del catálogo — ya no se vende
--
-- POR QUÉ: al cargar los siete precios del GoPro (sql/2026-08-31_17_...) este
-- producto quedó como la única excepción al 25 % de la familia: seguía al 30 %
-- porque no venía en la lista del dueño. Confirmó que ya no se usa.
--
-- POR QUÉ `activo = false` Y NO UN DELETE: data.js carga el catálogo con
-- .eq("activo", true), así que basta para que desaparezca del selector de
-- Ventas, que es el efecto que se pedía. Cero ventas lo referencian
-- (comprobado antes de aplicar), así que borrarlo también habría sido seguro;
-- simplemente no hace falta una acción irreversible para el mismo resultado, y
-- el id y el precio quedan por si el producto vuelve.
--
-- Ojo: esto NO es una columna muerta de las que persigue el brain. `activo` es
-- un estado explícito que el cargador ya filtra, no un campo sin lectores.

update productos set activo = false where id = 'gopro_vip';

-- COMPROBADO tras aplicar: el catálogo de bots activos queda en 13 productos y
-- los nueve de la familia GoPro dan 25.00 % exacto. Ya no hay excepción.
