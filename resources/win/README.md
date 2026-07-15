# Configuration Windows pour PecExpress Desktop

## Fonctionnement

Sur Windows, l'imprimante virtuelle PecExpress utilise **mfilemon** (Multi-File Port Monitor) pour rediriger automatiquement les impressions vers un dossier surveillé par l'application.

## Prérequis

### Option 1 : Installation automatique avec mfilemon (recommandé)

1. Télécharger mfilemon depuis : https://github.com/nicoleee0/mfilemon/releases
2. Copier les fichiers dans ce dossier :
   - `mfilemon64.dll` pour Windows 64-bit
   - `mfilemon32.dll` pour Windows 32-bit (optionnel)

L'application installera automatiquement le port monitor et configurera l'imprimante.

### Option 2 : Mode manuel (sans mfilemon)

Si mfilemon n'est pas disponible, l'application crée une imprimante "PECExpress_PEC" utilisant "Microsoft Print To PDF".

Dans ce mode, l'utilisateur doit **sauvegarder manuellement** chaque document dans le dossier :
```
%LOCALAPPDATA%\PecExpress\spool\
```

L'application détectera automatiquement les nouveaux fichiers PDF dans ce dossier.

## Dossiers

- **Spool** : `%LOCALAPPDATA%\PecExpress\spool\` - Documents à traiter
- **Logs** : `%USERPROFILE%\PecExpress\logs\` - Journaux de l'application
- **Traités** : `%USERPROFILE%\PecExpress\logs\processed\` - Documents traités

## Dépannage

### L'imprimante n'apparaît pas
1. Redémarrer l'application
2. Vérifier les logs dans `%USERPROFILE%\PecExpress\logs\app.log`

### Le document n'est pas détecté
1. Vérifier que le fichier PDF est bien dans `%LOCALAPPDATA%\PecExpress\spool\`
2. L'application doit être en cours d'exécution

### Erreur "mfilemon.dll non trouvé"
Téléchargez mfilemon depuis le lien ci-dessus et placez le fichier DLL dans ce dossier.
