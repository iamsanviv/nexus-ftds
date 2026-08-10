"""
Revisa un archivo de llave privada sin enseñar su contenido.

POR QUÉ
-------
Cuando la llave no carga, el impulso es abrirla en un editor para ver qué tiene.
Es exactamente lo que no hay que hacer: es una credencial, y varios editores de
Windows la modifican con solo guardarla (marca BOM, saltos de línea, UTF-16).
Este script mira la estructura —cuántas líneas, qué encabezados, qué caracteres
sobran— y no imprime jamás el material de la llave.

    python3 mcp/oracle/revisar_llave.py                       (la del ~/.oci/config)
    python3 mcp/oracle/revisar_llave.py "D:\\ruta\\clave.pem"  (una concreta)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firma      # noqa: E402
import servidor   # noqa: E402

VALIDOS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")


def main():
    if len(sys.argv) > 1:
        ruta = os.path.expanduser(sys.argv[1].strip().strip('"'))
    else:
        try:
            cred_ruta = os.path.expanduser(
                os.environ.get("OCI_CONFIG_FILE", "~/.oci/config"))
            print(f"Tomando la ruta del config: {cred_ruta}")
            import configparser
            cfg = configparser.ConfigParser(inline_comment_prefixes=("#",))
            cfg.read(cred_ruta, encoding="utf-8-sig")
            perfil = os.environ.get("OCI_PROFILE", "DEFAULT")
            sec = cfg[perfil] if cfg.has_section(perfil) else cfg.defaults()
            ruta = os.path.expanduser((sec.get("key_file") or "").strip())
        except Exception as exc:  # noqa: BLE001
            print(f"No se pudo leer el config: {exc}")
            print("Pasa la ruta del .pem como argumento.")
            return 1

    print(f"\nArchivo: {ruta}")
    if not os.path.exists(ruta):
        print("  NO EXISTE. Revisa la ruta de key_file en tu config.")
        return 1

    crudo = open(ruta, "rb").read()
    print(f"  Tamaño: {len(crudo)} bytes")

    # Señales de que un editor tocó el archivo. Cada una tiene arreglo distinto.
    problemas = []
    if crudo.startswith(b"\xef\xbb\xbf"):
        problemas.append("Empieza con marca BOM (lo guardó un editor de Windows).")
    if crudo.startswith(b"\xff\xfe") or crudo.startswith(b"\xfe\xff"):
        problemas.append("Está en UTF-16, no en texto plano. Vuelve a descargarlo.")
    if b"\x00" in crudo:
        problemas.append("Tiene bytes nulos: no es un PEM de texto.")
    if b"\r\n" in crudo:
        problemas.append("Tiene saltos de línea de Windows (inofensivo, se ignoran).")

    try:
        texto = crudo.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        print(f"  No se puede leer como texto: {exc}")
        print("  → No es un PEM. Vuelve a descargar la llave de Oracle.")
        return 1

    lineas = [l.strip() for l in texto.strip().splitlines()]
    encabezados = [l for l in lineas if "-----" in l]
    cuerpo = [l for l in lineas if l and "-----" not in l]

    print(f"  Líneas totales: {len(lineas)}  ·  de contenido: {len(cuerpo)}")
    print("  Encabezados encontrados:")
    for e in encabezados:
        print(f"    {e}")
    if not encabezados:
        print("    NINGUNO — un PEM debe traer '-----BEGIN ... KEY-----'.")

    intrusos = sorted({c for l in cuerpo for c in l.replace(" ", "")
                       if c not in VALIDOS})
    if intrusos:
        print("  Caracteres que no son base64 en el contenido:")
        for c in intrusos[:10]:
            print(f"    {c!r}  (U+{ord(c):04X})")
    else:
        print("  Contenido: solo caracteres base64 válidos.")

    for p in problemas:
        print(f"  AVISO: {p}")

    print()
    try:
        n, d = firma.cargar_llave(texto)
        print(f"RESULTADO: la llave carga bien. RSA de {n.bit_length()} bits.")
        print("El problema, si lo hay, no está en la llave.")
        return 0
    except firma.ErrorFirma as exc:
        print(f"RESULTADO: la llave NO carga.\n\n{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
