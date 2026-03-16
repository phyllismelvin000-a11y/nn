/**
 * Script pour obtenir un token Wave Business et le wallet ID.
 * À lancer une fois : node scripts/wave-login.js
 * Puis ajoute dans .env : WAVE_BUSINESS_TOKEN=... et WAVE_BUSINESS_WALLET_ID=...
 *
 * Prérequis : WAVE_BUSINESS_MOBILE et WAVE_BUSINESS_PIN dans .env (ou on te les demandera).
 */

require('dotenv').config();
const readline = require('readline');
const { randomUUID } = require('crypto');

const WAVE_GRAPHQL_URL = 'https://ci.mmapp.wave.com/a/business_graphql';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function graphqlPost(query, variables, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://business.wave.com',
    'Referer': 'https://business.wave.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (token) {
    headers['Authorization'] = 'Basic ' + Buffer.from(':' + token).toString('base64');
  }
  const res = await fetch(WAVE_GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  return { res, data };
}

/** Format international : si le numéro ne commence pas par +, on ajoute l'indicatif pays (défaut +225 Côte d'Ivoire). En CI le 0 après l’indicatif est conservé (ex. 0171379009 → +2250171379009). */
function normalizeMobile(input) {
  const s = (input || '').trim().replace(/\s/g, '');
  if (/^\+/.test(s)) return s;
  const countryCode = (process.env.WAVE_BUSINESS_COUNTRY_CODE || '225').replace(/^0+/, '');
  const rest = s.startsWith('0') ? s : '0' + s;
  return '+' + countryCode + rest;
}

async function main() {
  let mobile = (process.env.WAVE_BUSINESS_MOBILE || '').trim();
  let pin = (process.env.WAVE_BUSINESS_PIN || '').trim();
  if (!mobile) mobile = await ask('Numéro Wave Business (ex. +2250712345678 ou 0171379009) : ');
  if (!pin) pin = await ask('Code PIN à 4 chiffres : ');
  if (!mobile || !pin) {
    console.error('Mobile et PIN requis.');
    process.exit(1);
  }
  mobile = normalizeMobile(mobile);
  console.log('   Numéro utilisé :', mobile);

  console.log('\n1. Démarrage de la connexion Wave…');
  const startAuthQuery = `mutation StartBusinessUserAuth_Mutation($mobile: String!) {
    startBusinessUserAuth(mobile: $mobile) { nextStep }
  }`;
  const { data: startData } = await graphqlPost(startAuthQuery, { mobile });
  if (startData.errors?.length) {
    console.error('Erreur startAuth:', startData.errors.map(e => e.message).join('; '));
    console.error('   Astuce : utilise le format international (+225...) et vérifie que le compte est bien un compte Wave Business.');
    process.exit(1);
  }

  const deviceId = randomUUID();
  console.log('2. Vérification du PIN (Wave envoie le SMS à ce moment)…');
  const verifyPinQuery = `mutation VerifyPin_Mutation($mobile: String!, $pin: String!, $deviceId: String!) {
    login(mobile: $mobile, pin: $pin, deviceInfo: { deviceId: $deviceId, deviceModel: "biz", deviceName: "biz" }) {
      token { id mobile length }
    }
  }`;
  const { data: pinData } = await graphqlPost(verifyPinQuery, { mobile, pin, deviceId });
  if (pinData.errors?.length || !pinData.data?.login?.token?.id) {
    console.error('Erreur verifyPin:', (pinData.errors || [{ message: 'Token absent' }]).map(e => e.message).join('; '));
    process.exit(1);
  }
  const tokenId = pinData.data.login.token.id;
  console.log('   PIN OK. Tu devrais recevoir un SMS sous peu.');
  await ask('   Appuie sur Entrée quand tu as reçu le SMS (attendre 30 s à 1 min si besoin)… ');
  console.log('');

  const code = await ask('3. Entre le code à 4 ou 6 chiffres reçu par SMS : ');
  if (!code) {
    console.error('Code SMS requis.');
    process.exit(1);
  }
  const codeDigits = code.replace(/\D/g, '');
  if (codeDigits.length < 4 || codeDigits.length > 8) {
    console.error('Le code Wave fait généralement 4 à 6 chiffres. Vérifie le SMS reçu.');
    process.exit(1);
  }

  console.log('\n4. Vérification du code SMS…');
  const verifySmsQuery = `mutation VerifySMS_Mutation($tokenId: String!, $code: String!, $pin: String!) {
    verifyAuthCode(tokenId: $tokenId, code: $code, pin: $pin) {
      session {
        sId
        id
        user {
          businessUser {
            business {
              wallet { id }
              id
            }
          }
        }
      }
    }
  }`;
  const { data: smsData } = await graphqlPost(verifySmsQuery, { tokenId, code: codeDigits, pin });
  if (smsData.errors?.length) {
    console.error('Erreur verifySMS:', smsData.errors.map(e => e.message).join('; '));
    process.exit(1);
  }

  const session = smsData.data?.verifyAuthCode?.session;
  if (!session) {
    console.error('Session absente dans la réponse.');
    process.exit(1);
  }

  const walletId = session.user?.businessUser?.business?.wallet?.id || null;
  const sId = session.sId || session.id;

  if (!sId) {
    console.error('Token de session (sId) absent. Wave peut utiliser un cookie.');
    console.log('Récupère le token depuis les DevTools (F12) → Network → une requête vers business_graphql → Request Headers → Authorization: Basic ...');
    console.log('Décode le base64 : la partie après ":" est WAVE_BUSINESS_TOKEN.');
    process.exit(1);
  }

  console.log('\n--- Ajoute ces lignes dans ton .env ---\n');
  console.log('WAVE_BUSINESS_TOKEN=' + sId);
  if (walletId) console.log('WAVE_BUSINESS_WALLET_ID=' + walletId);
  console.log('\n----------------------------------------\n');
  if (!walletId) {
    console.log('Si WAVE_BUSINESS_WALLET_ID est absent, ouvre Wave Business → Transactions, puis dans l’onglet Network (F12) trouve une requête "business_graphql" et dans les variables tu verras walletOpaqueId (ex. W_ci_...).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
