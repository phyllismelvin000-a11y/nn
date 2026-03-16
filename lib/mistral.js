/**
 * Intégration API Mistral pour le bot WhatsApp : conversation 100 % naturelle.
 * L'IA se comporte comme une caissière : elle présente le catalogue en fonction
 * de ce que dit l'utilisateur, lui demande de choisir, et peut proposer une commande
 * (ACTION:productId|quantity|months) quand tout est clair.
 */
require('dotenv').config();

const { getActiveProductsByCategory } = require('../catalogue');

const MISTRAL_API_KEY = (process.env.MISTRAL_API_KEY || '').trim();
const MISTRAL_MODEL = (process.env.MISTRAL_MODEL || 'mistral-small-latest').trim();
const MISTRAL_BASE = 'https://api.mistral.ai/v1';

const MAX_HISTORY = 20;

/**
 * Construit le contexte catalogue avec les IDs produit (pour que l'IA puisse renvoyer une action).
 * @returns {Promise<string>}
 */
async function buildCatalogueContext() {
  const [netflix, onoff, vpn] = await Promise.all([
    getActiveProductsByCategory('netflix'),
    getActiveProductsByCategory('onoff'),
    getActiveProductsByCategory('vpn'),
  ]);

  const lines = ['Catalogue (utilise exactement ces productId pour l\'action) :'];

  if (netflix.length) {
    const p = netflix[0];
    const stock = p.stock ?? 0;
    lines.push(`- Netflix : productId=${p.id}, ${p.prix || 0} FCFA/mois, durées 1 à 12 mois, stock ${stock}`);
  } else {
    lines.push('- Netflix : indisponible');
  }

  if (onoff.length) {
    onoff.forEach((p) => {
      const titre = p.titre || '';
      const stock = p.stock ?? 0;
      lines.push(`- Onoff ${titre} : productId=${p.id}, ${p.prix || 0} FCFA/mois, durées 1 à 3 mois, stock ${stock}`);
    });
  } else {
    lines.push('- Onoff : indisponible');
  }

  if (vpn.length) {
    vpn.forEach((p) => {
      lines.push(`- VPN ${p.titre || 'VPN'} : productId=${p.id}, ${p.prix || 0} FCFA, quantité 1 à 5, durées 1 à 6 mois`);
    });
  } else {
    lines.push('- VPN : indisponible');
  }

  return lines.join('\n');
}

/**
 * Extrait une action PROPOSE_ORDER de la réponse (ligne ACTION:productId|quantity|months).
 * @param {string} text - Réponse brute de l'IA
 * @returns {{ text: string, action: { productId: string, quantity: number, months: number } | null }}
 */
function parseAction(text) {
  const actionMatch = text.match(/\nACTION:([^\s|]+)\|(\d+)\|(\d+)\s*$/);
  if (!actionMatch) return { text: text.trim(), action: null };
  const cleanText = text.replace(/\nACTION:[^\n]+$/, '').trim();
  return {
    text: cleanText,
    action: {
      productId: actionMatch[1].trim(),
      quantity: Math.max(1, parseInt(actionMatch[2], 10)),
      months: Math.max(1, parseInt(actionMatch[3], 10)),
    },
  };
}

/**
 * Appelle l'API Mistral avec historique de conversation.
 * @param {string} userMessage - Message de l'utilisateur
 * @param {Array<{ role: 'user'|'assistant', content: string }>} [conversationHistory] - Historique (derniers échanges)
 * @returns {Promise<{ text: string, action: { productId: string, quantity: number, months: number } | null, error?: string }>}
 */
async function chat(userMessage, conversationHistory = []) {
  if (!MISTRAL_API_KEY) {
    return { text: '', action: null, error: 'MISTRAL_API_KEY non configurée' };
  }

  const context = await buildCatalogueContext();
  const systemPrompt = `Tu es la caissière WhatsApp d'un vendeur d'abonnements (Netflix, Onoff Premium/Start, VPN) en Côte d'Ivoire. Paiement par Wave uniquement.

COMPORTEMENT :
- Conversation 100 % naturelle. Aucune consigne du type "tape 2", "répondez 1 ou 2". Tu parles comme une vraie personne.
- Si le client demande ce que vous vendez ou veut voir le catalogue : décris les produits (noms, prix, dispo) avec tes mots et demande-lui lequel il veut.
- S'il dit ce qu'il veut (ex. "je veux Onoff", "Netflix 3 mois", "un VPN pour X mois") : pose les questions manquantes (Premium ou Start pour Onoff, durée, quantité pour VPN, etc.) de façon naturelle.
- Quand tu as tout (produit + durée, et quantité pour VPN si besoin), fais un récap en une phrase puis ajoute exactement une seule ligne à la fin de ta réponse (sans rien après) :
  ACTION:productId|quantity|months
  où productId est l'id du produit dans le catalogue ci-dessous, quantity = 1 pour Netflix/Onoff (ou 1-5 pour VPN), months = durée en mois (1-12 Netflix, 1-3 Onoff, 1-6 VPN).
  Exemple pour Onoff Premium 2 mois : ACTION:abc123|1|2
  IMPORTANT : ne mélange jamais les catégories. Ne renvoie jamais un productId d'Onoff si tu es en train de proposer un VPN, et ne renvoie jamais un productId de VPN si tu es en train de proposer Netflix ou Onoff.
  N'écris rien après cette ligne. Le client confirmera ensuite par "oui".

Règles : réponses courtes (1 à 4 phrases), chaleureuses, tutoiement si le client tutoie. Après création de commande : le client paie via le lien Wave puis envoie l'ID de transaction (ex. T_xxx) ici.

Catalogue :
${context}`;

  const history = conversationHistory.slice(-MAX_HISTORY);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: String(userMessage || '').trim() || 'Bonjour' },
  ];

  const body = {
    model: MISTRAL_MODEL,
    messages,
    max_tokens: 320,
    temperature: 0.5,
  };

  try {
    const res = await fetch(`${MISTRAL_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[Mistral] API error', res.status, errText);
      return { text: '', action: null, error: `API ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const rawText = (choice && choice.message && choice.message.content) ? choice.message.content.trim() : '';
    const { text, action } = parseAction(rawText);

    return {
      text: text || "Désolé, je n'ai pas pu répondre. Dis-moi ce que tu cherches.",
      action,
    };
  } catch (e) {
    console.error('[Mistral]', e.message);
    return { text: '', action: null, error: e.message };
  }
}

function isConfigured() {
  return Boolean(MISTRAL_API_KEY);
}

module.exports = {
  buildCatalogueContext,
  chat,
  parseAction,
  isConfigured,
};
