// Windows UI Automation. Dos usos:
//  - listVisibleControls(): los controles interactivos visibles (botones,
//    menús, pestañas...) para numerarlos en la captura. La IA elige un número
//    en vez de adivinar píxeles: es lo que hace que señale con precisión.
//  - elementAtPoint(): el control bajo un punto, para encajar el resaltado
//    cuando la IA da coordenadas.
// Un único proceso PowerShell vive en segundo plano para responder rápido.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { screen, type Rectangle } from 'electron';

export interface UiElement {
  name: string;
  controlType: string;
  /** Rectángulo en DIP globales. */
  rect: Rectangle;
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace ClickyNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr FindWindow(string cls, string title);
'@
# Per-monitor v2: coordenadas en píxeles físicos reales en todos los monitores.
[void][ClickyNative.Win]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4))
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]

$interactive = @($CT::Button, $CT::MenuItem, $CT::Hyperlink, $CT::Edit, $CT::ComboBox, $CT::CheckBox,
  $CT::RadioButton, $CT::TabItem, $CT::ListItem, $CT::TreeItem, $CT::SplitButton, $CT::Slider,
  $CT::Spinner, $CT::DataItem, $CT::Image)
$typeCond = New-Object System.Windows.Automation.OrCondition (@($interactive | ForEach-Object {
  New-Object System.Windows.Automation.PropertyCondition ($A::ControlTypeProperty, $_) }))
$visibleCond = New-Object System.Windows.Automation.PropertyCondition ($A::IsOffscreenProperty, $false)
$listCond = New-Object System.Windows.Automation.AndCondition ($typeCond, $visibleCond)

$cache = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty)) { $cache.Add($p) }

function Rect($r) { @{ x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height } }

function List-Controls {
  $roots = @()
  $fg = [ClickyNative.Win]::GetForegroundWindow()
  if ($fg -ne [System.IntPtr]::Zero) { $roots += $A::FromHandle($fg) }
  $tray = [ClickyNative.Win]::FindWindow('Shell_TrayWnd', $null)
  if ($tray -ne [System.IntPtr]::Zero -and $tray -ne $fg) { $roots += $A::FromHandle($tray) }
  $items = New-Object System.Collections.ArrayList
  $active = $cache.Activate()
  try {
    foreach ($root in $roots) {
      foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)) {
        $c = $el.Cached
        $r = $c.BoundingRectangle
        if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { continue }
        [void]$items.Add(@{ n = $c.Name; t = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); r = (Rect $r) })
        if ($items.Count -ge 400) { break }
      }
    }
  } finally { $active.Dispose() }
  return ,$items.ToArray()
}

function At-Point($x, $y) {
  $pt = New-Object System.Windows.Point $x, $y
  $el = $A::FromPoint($pt)
  # FromPoint a veces se queda en un Pane contenedor (XAML, barra de tareas):
  # bajamos al hijo más pequeño que contenga el punto.
  for ($depth = 0; $depth -lt 10; $depth++) {
    $best = $null; $bestArea = [double]::MaxValue
    foreach ($child in $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      $cr = $child.Current.BoundingRectangle
      if (-not $cr.IsEmpty -and $cr.Contains($pt) -and ($cr.Width * $cr.Height) -lt $bestArea) {
        $best = $child; $bestArea = $cr.Width * $cr.Height
      }
    }
    if ($null -eq $best) { break }
    $el = $best
  }
  $c = $el.Current
  return @{ n = $c.Name; t = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); r = (Rect $c.BoundingRectangle) }
}

[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ')
  $id = $parts[0]
  try {
    if ($parts[1] -eq 'E') { $data = List-Controls } else { $data = At-Point ([double]$parts[2]) ([double]$parts[3]) }
    $json = ConvertTo-Json -Compress -Depth 4 -InputObject @{ id = $id; ok = $true; data = $data }
  } catch {
    $json = ConvertTo-Json -Compress -InputObject @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine($json)
}
`;

interface RawElement {
  n: string | null;
  t: string;
  r: { x: number; y: number; w: number; h: number };
}

// Controles demasiado genéricos para resaltar al hacer "snap" a un punto.
const IGNORED_AT_POINT = /^(Window|Pane|Document|Group|Custom|TitleBar|Table|Tree|List|ToolBar|MenuBar|Tab|ScrollBar)$/;

let proc: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
const pending = new Map<number, (msg: { ok: boolean; data?: unknown }) => void>();
let nextId = 1;
let buffer = '';

function ensureProcess() {
  if (proc && ready) return ready;
  // Script por -EncodedCommand; stdin queda libre solo para nuestras peticiones.
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
  });
  proc = child;
  buffer = '';
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UI Automation no arrancó')), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === 'READY') {
          clearTimeout(timer);
          resolve();
        } else if (line.startsWith('{')) {
          try {
            const msg = JSON.parse(line);
            pending.get(Number(msg.id))?.(msg);
            pending.delete(Number(msg.id));
          } catch {
            // línea corrupta: la petición acabará por timeout
          }
        }
      }
    });
    child.on('exit', () => {
      if (proc === child) {
        proc = null;
        ready = null;
      }
      for (const done of pending.values()) done({ ok: false });
      pending.clear();
    });
  });
  ready.catch(() => child.kill());
  return ready;
}

async function request(command: string, timeoutMs: number): Promise<unknown> {
  if (process.platform !== 'win32') return null;
  await ensureProcess();
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg.ok ? msg.data : null);
    });
    proc!.stdin.write(`${id} ${command}\r\n`);
  });
}

function toDip(raw: RawElement): UiElement | null {
  if (!(raw.r.w > 0) || !(raw.r.h > 0)) return null;
  const rect = screen.screenToDipRect(null, {
    x: Math.round(raw.r.x),
    y: Math.round(raw.r.y),
    width: Math.round(raw.r.w),
    height: Math.round(raw.r.h),
  });
  return { name: (raw.n ?? '').trim(), controlType: raw.t, rect };
}

/** Arranca PowerShell por adelantado para que la primera consulta no tarde. */
export function warmUpUiAutomation() {
  if (process.platform === 'win32') ensureProcess().catch(() => {});
}

/**
 * Controles interactivos visibles de la ventana activa y la barra de tareas,
 * en DIP globales. Se descartan los demasiado grandes y los duplicados.
 */
export async function listVisibleControls(timeoutMs = 2500): Promise<UiElement[]> {
  try {
    const raw = (await request('E', timeoutMs)) as RawElement[] | null;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: UiElement[] = [];
    for (const item of raw) {
      const el = toDip(item);
      if (!el) continue;
      const display = screen.getDisplayMatching(el.rect).bounds;
      if (el.rect.width > display.width * 0.6 || el.rect.height > display.height * 0.5) continue;
      // Fuera de toda pantalla (p.ej. ventanas minimizadas a -32000).
      if (el.rect.x + el.rect.width < display.x || el.rect.y + el.rect.height < display.y) continue;
      const key = `${Math.round(el.rect.x / 3)},${Math.round(el.rect.y / 3)},${Math.round(el.rect.width / 3)},${Math.round(el.rect.height / 3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  } catch {
    return [];
  }
}

/** Elemento bajo un punto global DIP, o null si no hay nada útil que resaltar. */
export async function elementAtPoint(point: { x: number; y: number }): Promise<UiElement | null> {
  try {
    const physical = screen.dipToScreenPoint(point);
    const raw = (await request(`P ${Math.round(physical.x)} ${Math.round(physical.y)}`, 1500)) as RawElement | null;
    if (!raw) return null;
    const el = toDip(raw);
    if (!el || IGNORED_AT_POINT.test(el.controlType)) return null;
    const display = screen.getDisplayNearestPoint(point).bounds;
    // Algo que ocupa media pantalla no es "el botón".
    if (el.rect.width > display.width * 0.5 || el.rect.height > display.height * 0.4) return null;
    if (el.rect.width < 4 || el.rect.height < 4) return null;
    return el;
  } catch {
    return null;
  }
}

export function stopUiAutomation() {
  proc?.kill();
}
