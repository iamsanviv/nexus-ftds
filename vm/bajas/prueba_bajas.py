"""Pruebas de bajas.py. Lo peligroso, no el camino feliz."""
import os, subprocess, sys, tempfile, importlib.util
from pathlib import Path

RAIZ = Path(tempfile.mkdtemp()) / "nexus-bridges"
RAIZ.mkdir(parents=True)
OW = {"fabian": "89d4f2f2-fcc8-441c-a580-feac23be0970",
      "evelin": "85bf65bc-1cf2-4216-ab37-6e9da96cbce3",
      "daniel": "04b73826-d5f9-4266-8880-58584078201d"}
for slug, uuid in OW.items():
    d = RAIZ / slug; d.mkdir()
    (d / "env").write_text(f"WA_PORT=8081\nWA_OWNER={uuid}\nWA_NAME={slug}\n")
# una baja YA hecha, archivada con punto
ya = RAIZ / ".baja-daniel-20260926-120000"; ya.mkdir()
(ya / "env").write_text(f"WA_OWNER={OW['daniel']}\n")
(RAIZ / "daniel").rename(RAIZ / ".tmp-daniel"); (RAIZ / ".tmp-daniel").rename(ya / "_orig") if False else None
import shutil; shutil.rmtree(RAIZ / ".tmp-daniel", ignore_errors=True)
# un directorio con nombre hostil
malo = RAIZ / "rm -rf ~"; malo.mkdir()
(malo / "env").write_text("WA_OWNER=11111111-2222-3333-4444-555555555555\n")

os.environ["SUPABASE_URL"] = "https://ejemplo.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "clave-de-prueba"
os.environ["NEXUS_BRIDGES"] = str(RAIZ)

spec = importlib.util.spec_from_file_location("bajas", Path(__file__).parent / "bajas.py")
bajas = importlib.util.module_from_spec(spec); spec.loader.exec_module(bajas)

fallos = 0
def chk(n, ok, extra=""):
    global fallos
    if ok: print("✓", n)
    else:  fallos += 1; print("✗", n, extra)

chk("encuentra el bridge de fabian por WA_OWNER",
    bajas.bridge_de(OW["fabian"]) == RAIZ / "fabian", bajas.bridge_de(OW["fabian"]))
chk("un owner que no está en esta máquina da None",
    bajas.bridge_de("00000000-0000-0000-0000-000000000000") is None)
chk("NO reencuentra una baja ya archivada (empieza por punto)",
    bajas.bridge_de(OW["daniel"]) is None, bajas.bridge_de(OW["daniel"]))

chk("el UUID de la base se valida", bool(bajas.RE_UUID.match(OW["evelin"])))
for basura in ["'; drop table canales_wa; --", "../../etc", "", "85BF65BC-1CF2-4216-AB37-6E9DA96CBCE3"]:
    chk(f"rechaza uuid {basura!r:45}", not bajas.RE_UUID.match(basura))

chk("acepta un slug normal", bool(bajas.RE_SLUG.match("fabian_florez")))
for basura in ["rm -rf ~", "a b", "../evelin", "ev$(id)", "-rf", ".oculto", "x" * 33, "Evelin"]:
    chk(f"rechaza slug {basura!r:14}", not bajas.RE_SLUG.match(basura))

# El nombre que produce el archivado TIENE que escapar del glob de bash.
sello = "20260926-133000"
for slug in ["fabian", "evelin"]:
    nombre = f".baja-{slug}-{sello}"
    (RAIZ / nombre).mkdir(exist_ok=True)
vistos = subprocess.run(["bash", "-c", "for d in */; do echo ${d%/}; done"],
                        cwd=RAIZ, capture_output=True, text=True).stdout.split()
chk("bash NO ve los directorios archivados por el script",
    not any(v.startswith(".baja-") for v in vistos), vistos)
chk("bash SÍ ve los bridges vivos", "fabian" in vistos and "evelin" in vistos, vistos)

# Y el contraejemplo que motivó todo esto.
(RAIZ / "evelin.bak").mkdir(exist_ok=True)
vistos2 = subprocess.run(["bash", "-c", "for d in */; do echo ${d%/}; done"],
                         cwd=RAIZ, capture_output=True, text=True).stdout.split()
chk("un '.bak' SÍ lo ve bash — por eso no se usa", "evelin.bak" in vistos2, vistos2)

print("\n" + ("todo en verde" if not fallos else f"{fallos} FALLO(S)"))
sys.exit(1 if fallos else 0)
