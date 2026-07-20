/**
 * Config Manager - Gestion de la configuration avec mise à jour cloud
 *
 * Stratégie:
 * 1. Charger la config locale (cache)
 * 2. Vérifier si une mise à jour cloud existe
 * 3. Fusionner avec les overrides locaux
 * 4. Sauvegarder en cache
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

// Chemins
const CONFIG_DIR = path.join(os.homedir(), 'PecExpress');
const CACHE_FILE = path.join(CONFIG_DIR, 'config-cache.json');
const OVERRIDES_FILE = path.join(CONFIG_DIR, 'config-overrides.json');

// URL de la config cloud
const CLOUD_CONFIG_URL = 'https://app.mondevisdentaire.com/api/desktop/config';

// Config par défaut (fallback si pas de cloud ni cache)
const DEFAULT_CONFIG = {
  version: '1.0.0',
  // Mode d'extraction du devis:
  //   'pdf'   = imprimante virtuelle PostScript -> PDF -> texte (universel, defaut)
  //   'logos' = lecture directe BDD Logos via MddReader.exe (rapide mais Logos uniquement)
  //   'auto'  = essaie PDF d'abord (timeout 3s), bascule sur Logos si echec
  extractionMode: 'auto',
  apiKey: '',
  modules: { pec: true, devis: true },
  pdfExtraction: {
    timeoutMs: 3000,           // delai avant fallback Logos en mode auto
    minConfidence: 60,         // score minimum pour considerer l'extraction valide
    keepPdfOnError: true       // garder PDF+PS sur disque pour debug si extraction echoue
  },
  extraction: {
    Y_TOLERANCE: 5,
    MIN_MONTANT: 5,
    MAX_MONTANT: 50000,
    MIN_PATIENT_X: 250
  },
  patterns: {
    ccam: '[A-Z]{4}\\d{3}',
    dent: '(?:1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])',
    nir: '^[12]\\d{12}(\\d{2})?$',
    date: '\\d{1,2}\\s*[/\\-\\.]\\s*\\d{1,2}\\s*[/\\-\\.]\\s*\\d{4}'
  },
  columnHeaders: {
    honoraires: ['honoraires', 'prix', 'montant'],
    panier: ['panier'],
    base: ['base', 'base remboursement', 'base de remboursement']
  },
  parasites: [
    'ADELI', 'RPPS', 'FINESS', 'CERFA', 'DEVIS', 'SOINS', 'DENT', 'DENTS',
    'DATE', 'ACTE', 'ACTES', 'CODE', 'CODES', 'CCAM', 'NGAP', 'TOTAL',
    'BASE', 'SANTÉ', 'SANTE', 'LIBRE', 'MODERE', 'SOLIDAIRE', 'PANIER',
    'MONTANT', 'BUCCO', 'UNION', 'EUROPÉENNE', 'TRAITEMENT', 'HONORAIRES',
    'REMBOURSEMENT', 'COMPLÉMENTAIRE', 'COMPLEMENTAIRE', 'FACTURATION',
    'PATIENT', 'PRATICIEN', 'CHIRURGIEN', 'DENTISTE', 'IDENTIFICATION'
  ],
  urls: {
    site: 'https://app.mondevisdentaire.com',
    pecNouvelle: 'https://app.mondevisdentaire.com/prises-en-charge/nouvelle',
    apiProcess: 'https://app.mondevisdentaire.com/api/desktop/process'
  },
  checkInterval: 3600000 // Vérifier les mises à jour toutes les heures
};

// Config actuelle (fusionnée)
let currentConfig = null;
let lastCheck = 0;

/**
 * Logger interne
 */
function log(message) {
  console.log(`[ConfigManager] ${message}`);
}

/**
 * Assure que le dossier de config existe
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Charge la config depuis le cache local
 */
function loadCachedConfig() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log(`Erreur lecture cache: ${e.message}`);
  }
  return null;
}

/**
 * Charge les overrides locaux
 */
function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      const data = fs.readFileSync(OVERRIDES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log(`Erreur lecture overrides: ${e.message}`);
  }
  return {};
}

/**
 * Sauvegarde la config en cache
 */
function saveCache(config) {
  try {
    ensureConfigDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(config, null, 2));
    log('Config sauvegardée en cache');
  } catch (e) {
    log(`Erreur sauvegarde cache: ${e.message}`);
  }
}

/**
 * Fusionne deux objets de config (deep merge)
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Télécharge la config depuis le cloud
 */
function fetchCloudConfig() {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOUD_CONFIG_URL);
    const protocol = url.protocol === 'https:' ? https : http;

    const req = protocol.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const config = JSON.parse(data);
          resolve(config);
        } catch (e) {
          reject(new Error(`JSON invalide: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Vérifie et télécharge les mises à jour cloud
 */
async function checkForUpdates() {
  const now = Date.now();
  const interval = currentConfig?.checkInterval || DEFAULT_CONFIG.checkInterval;

  if (now - lastCheck < interval) {
    return false; // Pas encore temps de vérifier
  }

  lastCheck = now;
  log('Vérification des mises à jour cloud...');

  try {
    const cloudConfig = await fetchCloudConfig();

    // Comparer les versions
    const cachedConfig = loadCachedConfig();
    const cachedVersion = cachedConfig?.version || '0.0.0';
    const cloudVersion = cloudConfig.version || '0.0.0';

    if (cloudVersion !== cachedVersion) {
      log(`Nouvelle version disponible: ${cachedVersion} → ${cloudVersion}`);
      saveCache(cloudConfig);

      // Recharger la config
      await loadConfig(true);
      return true;
    } else {
      log('Config à jour');
    }
  } catch (e) {
    log(`Erreur vérification cloud: ${e.message}`);
  }

  return false;
}

/**
 * Charge la configuration complète
 * @param forceRefresh - Force le rechargement depuis le cache
 */
async function loadConfig(forceRefresh = false) {
  if (currentConfig && !forceRefresh) {
    return currentConfig;
  }

  log('Chargement de la configuration...');

  // 1. Commencer avec la config par défaut
  let config = { ...DEFAULT_CONFIG };

  // 2. Fusionner avec le cache local
  const cachedConfig = loadCachedConfig();
  if (cachedConfig) {
    config = deepMerge(config, cachedConfig);
    log(`Config cache chargée (version ${cachedConfig.version})`);
  }

  // 3. Essayer de télécharger la config cloud (en arrière-plan pour ne pas bloquer)
  if (!cachedConfig) {
    try {
      const cloudConfig = await fetchCloudConfig();
      config = deepMerge(config, cloudConfig);
      saveCache(cloudConfig);
      log(`Config cloud chargée (version ${cloudConfig.version})`);
    } catch (e) {
      log(`Config cloud non disponible: ${e.message}, utilisation du défaut`);
    }
  }

  // 4. Appliquer les overrides locaux
  const overrides = loadOverrides();
  if (Object.keys(overrides).length > 0) {
    config = deepMerge(config, overrides);
    log('Overrides locaux appliqués');
  }

  currentConfig = config;
  return config;
}

/**
 * Retourne la config actuelle (sync)
 */
function getConfig() {
  if (!currentConfig) {
    // Charger de manière synchrone depuis le cache si pas encore initialisé
    let config = { ...DEFAULT_CONFIG };
    const cachedConfig = loadCachedConfig();
    if (cachedConfig) {
      config = deepMerge(config, cachedConfig);
    }
    const overrides = loadOverrides();
    if (Object.keys(overrides).length > 0) {
      config = deepMerge(config, overrides);
    }
    currentConfig = config;
  }
  return currentConfig;
}

/**
 * Sauvegarde un override local
 */
function setOverride(key, value) {
  const overrides = loadOverrides();

  // Supporter la notation pointée: "extraction.Y_TOLERANCE"
  const keys = key.split('.');
  let current = overrides;

  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }

  current[keys[keys.length - 1]] = value;

  try {
    ensureConfigDir();
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
    log(`Override sauvegardé: ${key} = ${JSON.stringify(value)}`);

    // Recharger la config
    currentConfig = null;
    loadConfig(true);
  } catch (e) {
    log(`Erreur sauvegarde override: ${e.message}`);
  }
}

/**
 * Efface l'appairage local (désappairage). Retire du fichier d'overrides la
 * clé API et tout ce qui identifie le compte/cabinet courant, de sorte que le
 * poste redevienne « non appairé » et puisse être reconnecté à un AUTRE compte
 * (au prochain clic Devis / PEC / Questionnaire, le flux d'appairage repart).
 * Ne touche pas aux réglages d'extraction ni aux chemins Logos locaux.
 */
function clearPairing() {
  const overrides = loadOverrides();
  for (const k of ['apiKey', 'cabinetName', 'isLabora', 'idPoste', 'modules', 'urls']) {
    delete overrides[k];
  }
  ensureConfigDir();
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  log('Appairage effacé (clé API + cabinet + urls réinitialisés)');
  // Recharge la config pour repartir sur les valeurs par défaut.
  currentConfig = null;
  loadConfig(true);
}

/**
 * Démarre la vérification périodique des mises à jour
 */
function startUpdateChecker() {
  // Vérifier immédiatement
  checkForUpdates();

  // Puis périodiquement
  setInterval(() => {
    checkForUpdates();
  }, 60000); // Vérifier toutes les minutes si l'intervalle est dépassé
}

module.exports = {
  loadConfig,
  getConfig,
  checkForUpdates,
  setOverride,
  startUpdateChecker,
  DEFAULT_CONFIG
};
