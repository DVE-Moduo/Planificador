# Planificador Semanal — PWA para Android

Aplicación web progresiva (PWA) instalable en Android sin tienda ni compilación.

---

## Instalación en 5 pasos

### Paso 1 — Crear cuenta en GitHub (gratis)
Ve a https://github.com y crea una cuenta gratuita.

### Paso 2 — Crear repositorio
1. Pulsa el botón verde "New" o ve a https://github.com/new
2. Nombre del repositorio: `planificador` (o el que prefieras)
3. Marca "Public"
4. Pulsa "Create repository"

### Paso 3 — Subir los archivos
1. En el repositorio recién creado, pulsa "uploading an existing file"
2. Arrastra TODOS los archivos de esta carpeta:
   - index.html
   - app.js
   - sw.js
   - manifest.json
   - icons/ (carpeta con los iconos)
3. Pulsa "Commit changes"

> IMPORTANTE: Los iconos (icon-192.png e icon-512.png) los puedes generar en:
> https://realfavicongenerator.net o usar cualquier imagen PNG cuadrada

### Paso 4 — Activar GitHub Pages
1. Ve a Settings (pestaña del repositorio)
2. En el menú izquierdo: Pages
3. Source: "Deploy from a branch"
4. Branch: main / (root)
5. Pulsa Save

En 1-2 minutos tendrás una URL como:
https://TU_USUARIO.github.io/planificador/

### Paso 5 — Instalar en Android
1. Abre Chrome en tu móvil Android
2. Ve a la URL de GitHub Pages
3. Chrome mostrará automáticamente "Añadir a pantalla de inicio"
4. Pulsa "Instalar" — ya tienes la app en tu móvil

Para que todo el equipo la instale, solo tienes que compartir la URL.

---

## Sincronización con SharePoint

La PWA guarda los datos localmente en cada dispositivo por defecto.

Para sincronizar con SharePoint/OneDrive necesitas configurar una app en Azure AD:

### Crear app en Azure AD
1. Ve a https://portal.azure.com
2. Azure Active Directory → App registrations → New registration
3. Nombre: "Planificador Semanal"
4. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
5. Redirect URI: Web → https://TU_USUARIO.github.io/planificador/index.html
6. Pulsa Register
7. Copia el "Application (client) ID"

### Configurar permisos
1. En tu app → API permissions → Add permission
2. Microsoft Graph → Delegated → Files.ReadWrite, User.Read
3. Grant admin consent

### Añadir el cliente ID al código
Abre app.js y rellena:
```javascript
const MSAL_CONFIG = {
  clientId: 'TU_CLIENT_ID_AQUI',
  tenantId: 'common',
  sharePointFile: 'Documentos/planificador_tareas.json',
};
```

También añade el script de MSAL en index.html antes de `<script src="app.js">`:
```html
<script src="https://alcdn.msauth.net/browser/2.38.0/js/msal-browser.min.js"></script>
```

### Uso
- Abre la app → pestaña Planificador → pulsa "Conectar SharePoint"
- Se abrirá el login de Microsoft
- Una vez conectado, pulsa "↻ Sync" para cargar/guardar datos compartidos

---

## Notificaciones en Android

Las notificaciones funcionan automáticamente:
- La primera vez que abres la app, Chrome pide permiso para notificaciones
- Acepta el permiso
- Las notificaciones aparecen a los 10min, 5min, al inicio y al fin de cada tarea

Para que funcionen cuando la app está en segundo plano, asegúrate de que Chrome tiene permiso de notificaciones en Ajustes → Aplicaciones → Chrome → Notificaciones.

---

## Estructura de archivos

```
planificador-pwa/
├── index.html      ← Interfaz completa optimizada para móvil
├── app.js          ← Lógica de la aplicación
├── sw.js           ← Service Worker (offline + notificaciones)
├── manifest.json   ← Configuración PWA
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```
