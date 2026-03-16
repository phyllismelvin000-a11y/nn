/**
 * Bot WhatsApp — même logique que le bot Telegram (catalogue, commandes, Wave).
 * Utilise whatsapp-web.js (connexion par QR code). Les commandes sont partagées avec Telegram (Firestore).
 * Lancer : npm run start:whatsapp
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { initFirebase, getDb } = require('./firebase');
const { getActiveProductsByCategory, getProductById, reserveCompteForOrder, decrementStock } = require('./catalogue');
const {
  createOrder,
  getLastPendingOrderByUser,
  getLastOrderByUser,
  getOrdersByUser,
  getOrderById,
  updateOrderStatus,
  updateOrderDeliveryData,
  updateOrderWaveTransactionId,
  findOrderByWaveTransactionId,
  STATUS,
} = require('./orders');
const { buildWaveLink } = require('./payment');
const { schedulePaymentReminderAndCancel, runPaymentTimeoutRecovery } = require('./lib/paymentTimers');
const { verifyTransactionIdInWave, isConfigured: isWaveConfigured } = require('./lib/waveGraphql');
const { saveUser, getUserByUserId, setUserWelcomed, getUsers } = require('./users');
const msg = require('./lib/messages');
const mistral = require('./lib/mistral');

const WAVE_ID_GUIDE_IMAGE_PATH = path.join(__dirname, 'assets', 'wave-id-transaction.png');
const WAVE_TRANSACTION_ID_REGEX = /T_[A-Za-z0-9]+/;

const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WHATSAPP_DATA_PATH = (process.env.WHATSAPP_DATA_PATH || '').trim();
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
const MAINTENANCE_MODE = /^(true|1|yes)$/i.test((process.env.MAINTENANCE_MODE || '').trim());
/** Admin sur WhatsApp (numéro avec indicatif, ex. 2250712345678). Si vide, pas de menu admin WhatsApp. */
const ADMIN_WHATSAPP_PHONE = (process.env.ADMIN_WHATSAPP_PHONE || '').replace(/\D/g, '');

function logHorodatage() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Id utilisateur WhatsApp : wa_2250712345678 (pour ne pas mélanger avec Telegram) */
function getWaUserId(from) {
  const id = from?.id || from;
  if (typeof id === 'string' && id.includes('@')) {
    const num = id.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    return num ? `wa_${num}` : null;
  }
  return id ? `wa_${id}` : null;
}

/** JID pour envoyer un message (2250712345678@c.us) */
function userIdToJid(userId) {
  if (typeof userId !== 'string') return null;
  const num = userId.startsWith('wa_') ? userId.slice(3) : userId;
  return `${num}@c.us`;
}

/** Délai aléatoire type humain (évite blocage WhatsApp pour envoi trop rapide). */
function humanDelayMs() {
  return 1200 + Math.floor(Math.random() * 2200); // 1,2 s à 3,4 s
}
function humanDelay() {
  return new Promise((r) => setTimeout(r, humanDelayMs()));
}
/** Répondre après un délai + indicateur « en train d'écrire » pour paraître humain. */
async function replyHuman(message, text) {
  try {
    const chat = await message.getChat();
    if (chat && typeof chat.sendStateTyping === 'function') {
      await chat.sendStateTyping();
    }
  } catch (_) {}
  await humanDelay();
  await message.reply(text);
  // Log en terminal : ce que le bot répond (préview 200 car.)
  const preview = String(text).replace(/\n/g, ' ').slice(0, 200);
  console.log(`[${logHorodatage()}] [WA] Bot → ${preview}${text.length > 200 ? '…' : ''}`);
}

/** Envoyer une notification à l'admin sur Telegram (pour les commandes WhatsApp) */
async function notifyAdminTelegram(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    console.error('Erreur envoi notification admin Telegram:', e.message);
  }
}

// ——— Adapter pour paymentTimers (sendMessage / sendPhoto vers un userId wa_*)
function createWaBotAdapter(client) {
  return {
    telegram: {
      sendMessage: async (userId, text) => {
        await humanDelay();
        const jid = userIdToJid(userId);
        if (!jid) return;
        try {
          await client.sendMessage(jid, text);
        } catch (e) {
          console.error(`[${logHorodatage()}] Erreur envoi rappel paiement (${userId}):`, e.message);
          if (/No LID|LID for user/i.test(e.message)) {
            console.error('  → WhatsApp exige parfois un LID pour ce contact. Le client doit avoir déjà écrit au bot.');
          }
        }
      },
      sendPhoto: async (userId, photo, opts = {}) => {
        await humanDelay();
        const jid = userIdToJid(userId);
        if (!jid) return;
        const caption = opts.caption || '';
        try {
          await client.sendMessage(jid, caption ? `${caption}\n\n_(Envoi de l’image désactivé sur WhatsApp pour cette notification.)_` : 'Image non envoyée.');
        } catch (e) {
          console.error(`[${logHorodatage()}] Erreur envoi photo rappel (${userId}):`, e.message);
          if (/No LID|LID for user/i.test(e.message)) {
            console.error('  → WhatsApp exige parfois un LID pour ce contact. Le client doit avoir déjà écrit au bot.');
          }
        }
      },
    },
  };
}

// ——— État par utilisateur (menu, catalogue, choix produit, etc.)
const userState = new Map();

function getState(userId) {
  if (!userState.has(userId)) userState.set(userId, { step: null, data: {} });
  return userState.get(userId);
}

function setState(userId, step, data = {}) {
  const s = getState(userId);
  s.step = step;
  s.data = { ...s.data, ...data };
}

// ——— Vérification pays / autorisation (numéro ivoirien +225)
function isIvorianNumber(userId) {
  const num = userId.startsWith('wa_') ? userId.slice(3) : userId;
  return num.startsWith('225') && num.length >= 9;
}

function isAdminByPhone(userId) {
  const num = userId.startsWith('wa_') ? userId.slice(3) : userId;
  return ADMIN_WHATSAPP_PHONE && String(ADMIN_WHATSAPP_PHONE) === String(num);
}

async function broadcastWhatsAppAnnouncement(client, text) {
  const users = await getUsers({ limit: 3000 });
  const waUsers = users.filter((u) => String(u.userId).startsWith('wa_'));
  if (!waUsers.length) return;
  let sent = 0;
  let failed = 0;
  for (const u of waUsers) {
    const jid = userIdToJid(u.userId);
    if (!jid) continue;
    await humanDelay();
    try {
      await client.sendMessage(jid, text);
      sent++;
    } catch (e) {
      failed++;
      console.error(`[${logHorodatage()}] Erreur envoi annonce WhatsApp à ${u.userId}:`, e.message);
    }
  }
  console.log(
    `[${logHorodatage()}] Annonce envoyée à ${sent} utilisateur(s) WhatsApp${failed ? `, ${failed} échec(s)` : ''}`
  );
}

async function processPendingAnnouncements(client) {
  const db = getDb();
  const snap = await db
    .collection('announcements')
    .where('sendToWhatsApp', '==', true)
    .where('whatsappSent', '==', false)
    .limit(5)
    .get();
  if (snap.empty) return;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const text = String(data.text || '').trim();
    if (!text) {
      await doc.ref.update({ whatsappSent: true, whatsappSentAt: new Date(), whatsappSkipReason: 'empty_text' });
      continue;
    }
    await broadcastWhatsAppAnnouncement(client, text);
    await doc.ref.update({ whatsappSent: true, whatsappSentAt: new Date() });
  }
}

async function run() {
  initFirebase();
  const client = new Client({
    authStrategy: new LocalAuth(
      WHATSAPP_DATA_PATH
        ? { clientId: 'novaabo-wa', dataPath: WHATSAPP_DATA_PATH }
        : { clientId: 'novaabo-wa' }
    ),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    },
    authTimeoutMs: 90000,
  });

  client.on('qr', async (qr) => {
    // #region agent log
    const _qrLen = typeof qr === 'string' ? qr.length : 0;
    const _urlLen = 55 + (typeof qr === 'string' ? encodeURIComponent(qr).length : 0);
    fetch('http://127.0.0.1:7469/ingest/5fea427c-524d-49b7-a9a5-f8a7dc6dea48',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29a20c'},body:JSON.stringify({sessionId:'29a20c',location:'whatsapp.js:qr',message:'QR received',data:{qrLength:_qrLen,imageUrlLength:_urlLen,over2048:_urlLen>2048},timestamp:Date.now(),hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    console.log('\n📱 Scannez ce QR code avec votre téléphone :');
    console.log('   WhatsApp → Paramètres → Appareils connectés → Lier un appareil\n');
    qrcode.generate(qr, { small: true });
    console.log('\n(QR valable ~20 s.)');
    console.log(
      'Si le téléphone affiche "Impossible de connecter l\'appareil" : arrêtez le bot, supprimez .wwebjs_auth et .wwebjs_cache, puis relancez.\n'
    );
    // Sauvegarder le QR dans Firestore pour le backoffice (/admin/whatsapp-qr)
    try {
      const db = getDb();
      await db.collection('meta').doc('whatsapp_qr').set(
        {
          qr,
          updatedAt: new Date(),
        },
        { merge: true }
      );
      console.log('QR WhatsApp enregistré pour le backoffice (/admin/whatsapp-qr).');
    } catch (e) {
      console.error('Erreur enregistrement QR WhatsApp dans Firestore:', e.message);
    }
  });

  client.on('auth_failure', (msg) => {
    // #region agent log
    fetch('http://127.0.0.1:7469/ingest/5fea427c-524d-49b7-a9a5-f8a7dc6dea48',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29a20c'},body:JSON.stringify({sessionId:'29a20c',location:'whatsapp.js:auth_failure',message:'Auth failure',data:{msg:String(msg||'').slice(0,200)},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    console.error('❌ Échec de connexion WhatsApp:', msg || 'auth_failure');
    console.error('   → Supprimez le dossier .wwebjs_auth (session) puis relancez npm run start:whatsapp');
  });

  client.on('disconnected', (reason) => {
    // #region agent log
    fetch('http://127.0.0.1:7469/ingest/5fea427c-524d-49b7-a9a5-f8a7dc6dea48',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29a20c'},body:JSON.stringify({sessionId:'29a20c',location:'whatsapp.js:disconnected',message:'Disconnected',data:{reason:String(reason||'').slice(0,200)},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    console.log('WhatsApp déconnecté:', reason);
  });

  client.on('ready', () => {
    // #region agent log
    fetch('http://127.0.0.1:7469/ingest/5fea427c-524d-49b7-a9a5-f8a7dc6dea48',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29a20c'},body:JSON.stringify({sessionId:'29a20c',location:'whatsapp.js:ready',message:'Ready',data:{},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    console.log('WhatsApp client prêt.');
    const waAdapter = createWaBotAdapter(client);
    runPaymentTimeoutRecovery(waAdapter, { userIdFilter: (id) => String(id).startsWith('wa_') }).then(() => {
      console.log('Timers de paiement (WhatsApp) chargés.');
    });
    setInterval(() => {
      processPendingAnnouncements(client).catch((e) =>
        console.error('[WA] Erreur traitement annonces WhatsApp:', e.message)
      );
    }, 60 * 1000);
  });

  client.on('message', async (message) => {
    let userId;
    let body;
    let isAdmin;
    let contactName = 'Client';
    try {
      const chat = await message.getChat();
      if (!chat.id) return;
      const from = message.from;
      userId = getWaUserId(from);
      if (!userId) return;

      body = (message.body || '').trim();
      if (!body) return; // Ignorer uniquement les messages vides (ex. "2" et "3" sont valides pour catalogue / ma commande)
      isAdmin = isAdminByPhone(userId);
      try {
        const contact = await message.getContact();
        contactName = contact?.pushname || contact?.name || contactName;
      } catch (_) {}

      console.log(`[${logHorodatage()}] [WA] ${userId} → ${body.slice(0, 60)}`);

      if (MAINTENANCE_MODE && !isAdmin && !ALLOWED_USER_IDS.has(userId)) {
        await replyHuman(message, msg.client.maintenance);
        return;
      }

      // Premier contact : salut + ce qu'on vend + comment commander (une seule fois) — ne pas bloquer si Firebase échoue
      if (!isAdmin) {
        try {
          const user = await getUserByUserId(userId);
          if (!user) {
            await replyHuman(message, msg.client.firstWelcome.replace(/<[^>]+>/g, ''));
            await saveUser({
              userId,
              phone_number: '+' + userId.replace('wa_', ''),
              firstName: contactName,
              username: '',
              countryAllowed: true,
              welcomed: true,
            });
          } else if (!user.welcomed) {
            await replyHuman(message, msg.client.firstWelcome.replace(/<[^>]+>/g, ''));
            await setUserWelcomed(userId);
          }
        } catch (e) {
          console.error('[WA] Erreur premier contact / Firebase:', e.message);
        }
      }

    // Admin : menu simplifié (stock)
    if (isAdmin) {
      if (/menu|bonjour|salut|stock|hello/i.test(body) && body.length < 20) {
        const [netflix, onoff, vpn] = await Promise.all([
          getActiveProductsByCategory('netflix'),
          getActiveProductsByCategory('onoff'),
          getActiveProductsByCategory('vpn'),
        ]);
        const lines = [msg.admin.stockTitle, ''];
        netflix.forEach((p) => { lines.push(`• ${p.titre || 'Netflix'} : ${p.stock ?? 0} en stock`); });
        onoff.forEach((p) => { lines.push(`• ${p.titre || 'Onoff'} : ${p.stock ?? 0} en stock`); });
        vpn.forEach((p) => { lines.push(`• 🔒 ${p.titre || 'VPN'} : illimité`); });
        if (netflix.length === 0 && onoff.length === 0 && vpn.length === 0) lines.push(msg.admin.noProduct);
        await replyHuman(message,lines.join('\n'));
        return;
      }
      await replyHuman(message,'Utilisez le bot Telegram pour la gestion complète (commandes, backoffice). Ici : répondez *Menu* pour le stock.');
      return;
    }

    // ID de transaction Wave : confirmer la commande en attente (même si l'utilisateur écrit "ID de transaction T_...")
    const txId = body.match(WAVE_TRANSACTION_ID_REGEX)?.[0] || null;
    if (txId) {
      const order = await getLastPendingOrderByUser(userId);
      if (!order) {
        await replyHuman(message,msg.client.noPendingOrder);
        return;
      }
      const ref = order.refCommande || order.id;
      const waveConfigured = isWaveConfigured();
      if (waveConfigured) {
        const verification = await verifyTransactionIdInWave(txId, order);
        if (!verification.valid) {
          await replyHuman(message,'❌ ' + verification.message);
          return;
        }
        const { alreadyUsed } = await findOrderByWaveTransactionId(txId, order.id);
        if (alreadyUsed) {
          await replyHuman(message,"❌ Cette transaction a déjà été utilisée pour une autre commande.");
          return;
        }
      }
      await confirmOrderWhatsApp(client, message, order, userId, contactName, { waveTransactionId: txId });
      return;
    }

    // Salut / Bonjour : réponse courte (le reste passe par la conversation)
    if (/^(salut|bonjour|coucou|hello|hey|yo|bonsoir)$/i.test(body)) {
      const greeting = /bonsoir/i.test(body)
        ? 'Bonsoir ! En quoi puis-je t\'aider ?'
        : /bonjour/i.test(body)
          ? 'Bonjour ! En quoi puis-je t\'aider ?'
          : 'Salut ! En quoi puis-je t\'aider ?';
      await replyHuman(message, greeting);
      return;
    }

    const state = getState(userId);

    // Commande en attente de confirmation : "oui" / "ok" (y compris variations type "oii", "ouii") → on crée la commande
    const isConfirmation = /^(oui+|ouii+|oi+|ok|d'?accord|ouais|ouaip|confirme|valide|c'est bon|c'est ça|oui c'est bon|oui c'est ça)$/i.test(
      body.trim()
    );
    if (state.data.pendingOrder && isConfirmation) {
      const { product, quantity, months } = state.data.pendingOrder;
      setState(userId, null, { pendingOrder: null });
      await createOrderAndSendWave(client, message, userId, contactName, product, quantity || 1, months);
      return;
    }
    if (state.data.pendingOrder && /^(non|annuler|cancel|pas ça)$/i.test(body.trim())) {
      setState(userId, null, { pendingOrder: null });
      await replyHuman(message, 'Pas de souci, on annule. Dis-moi si tu veux autre chose.');
      return;
    }

    // Ma commande
    if (/^(3|ma commande|commande|suivi)$/i.test(body)) {
      const order = await getLastOrderByUser(userId);
      if (!order) {
        await replyHuman(message,msg.client.myOrderNone);
        return;
      }
      const ref = order.refCommande || order.id;
      const label = msg.client.myOrderStatus[order.status] || order.status;
      const detail = order.produit?.titre ? ` — ${order.produit.titre}` : '';
      await replyHuman(message,`*Ma commande*\n\nRéf. ${ref}${detail}\n\nStatut : ${label}`);
      return;
    }

    // Commande en attente de paiement : proposer d'annuler si le client dit qu'il ne veut plus
    const pending = await getLastPendingOrderByUser(userId);
    if (pending) {
      const ref = pending.refCommande || pending.id;
      const wantCancel = /^(annuler|annule|cancel|pas intéressé|plus intéressé|je ne suis plus intéressé|j'?suis plus intéressé|jsuis plus intéressé|je veux plus|je ne veux plus|annule la commande)$/i.test(body.trim())
        || /(annuler|annule|cancel|pas intéressé|plus intéressé|suis plus intéressé)/i.test(body.trim()) && body.length < 80;
      if (wantCancel) {
        await updateOrderStatus(pending.id, STATUS.ANNULEE);
        await replyHuman(message, `Pas de souci, la commande ${ref} est annulée. Dis-moi si tu veux autre chose.`);
        return;
      }
      await replyHuman(message,
        msg.client.sendImageForOrder(ref).replace(/<[^>]+>/g, '') +
          '\n\nEnvoyez l\'ID de transaction (ex. T_5EPGALU...) après votre paiement Wave.'
      );
      return;
    }

    // Conversation naturelle : tout passe par Mistral (historique + proposition de commande si l'IA a tout)
    if (mistral.isConfigured()) {
      const history = state.data.conversationHistory || [];
      const { text, action, error } = await mistral.chat(body, history);

      if (error) console.error('[WA] Mistral:', error);

      if (text) {
        let reply = text;

        if (action && action.productId) {
          const product = await getProductById(action.productId);
          if (product) {
            const qty = Math.min(5, Math.max(1, action.quantity || 1));
            const months = action.months || 1;
            const isVpn = (product.categorie || '').toLowerCase() === 'vpn';
            const isOnoff = (product.categorie || '').toLowerCase() === 'onoff';
            const stock = product.stock ?? 0;

            // Sécurité : si le texte de l'IA parle clairement de VPN mais que le produit est Onoff (ou inversement), ignorer l'action.
            const lowerText = text.toLowerCase();
            const talksAboutVpn = lowerText.includes('vpn');
            const talksAboutOnoff = lowerText.includes('onoff');
            if ((isOnoff && talksAboutVpn) || (isVpn && talksAboutOnoff)) {
              console.warn(
                '[WA] Action Mistral ignorée car catégorie produit incohérente avec le texte:',
                product.categorie,
                '←→',
                text
              );
            } else if (isVpn || stock >= qty) {
              const total = (product.prix || 0) * qty * months;
              const newPendingOrder = { product, quantity: qty, months };
              setState(userId, null, { pendingOrder: newPendingOrder });
              reply = `${text}\n\nC'est bien *${product.titre || 'Produit'}* — ${
                qty > 1 ? qty + ' x ' : ''
              }${months} mois pour *${total} FCFA* ? Réponds *oui* pour que je prépare la commande.`;
            }
          }
        }

        await replyHuman(message, reply);

        const newHistory = [
          ...history.slice(-18),
          { role: 'user', content: body },
          { role: 'assistant', content: text },
        ];
        setState(userId, null, { conversationHistory: newHistory });
        return;
      }
    }
    await replyHuman(message, 'Dis-moi ce que tu cherches (abonnements Netflix, Onoff, VPN) ou pose une question.');
    } catch (e) {
      console.error('[WA] Erreur traitement message:', e.message);
      try {
        await message.reply(msg.errors?.generic || 'Désolé, une erreur est survenue. Réessayez.');
      } catch (_) {}
    }
  });

  async function createOrderAndSendWave(client, message, userId, contactName, product, quantity, dureeMois = null) {
    const freshProduct = await getProductById(product.id);
    if (!freshProduct) {
      await replyHuman(message, 'Produit indisponible.');
      return;
    }
    const stock = Math.max(0, freshProduct.stock ?? 0);
    const isVpn = (product.categorie || '').toLowerCase() === 'vpn';
    if (!isVpn && stock < quantity) {
      await replyHuman(message,stock === 0 ? msg.catalogue.noStockNoLink : msg.catalogue.noStockNoLinkCount(stock));
      return;
    }
    const order = await createOrder({
      userId,
      username: contactName,
      product: {
        id: freshProduct.id,
        titre: freshProduct.titre,
        prix: freshProduct.prix,
        quantite: quantity,
        ...(dureeMois != null && { dureeMois }),
        ...(freshProduct.categorie && { categorie: freshProduct.categorie }),
      },
    });
    const total = order.produit.total;
    const waAdapter = createWaBotAdapter(client);
    schedulePaymentReminderAndCancel(waAdapter, order);
    const link = buildWaveLink(total, order.refCommande);
    const detail =
      dureeMois != null
        ? `${freshProduct.titre} — ${dureeMois} mois x ${quantity} = ${total} FCFA`
        : `${freshProduct.titre} x${quantity} = ${total} FCFA`;
    console.log(`[${logHorodatage()}] [WA] Commande créée ref=${order.refCommande} par ${contactName}`);
    const orderText =
      msg.catalogue.orderCreated(order.refCommande, detail).replace(/<[^>]+>/g, '') +
      `\n\nPayer : ${link}\n\nAprès paiement, envoyez l'ID de transaction (ex. T_5EPGALU...) ici.`;
    // Si le produit a une image, envoyer l'image avec le récap en légende (comme sur Telegram).
    const jid = userIdToJid(userId);
    const imageUrl = freshProduct.imageUrl || null;
    if (jid && imageUrl) {
      try {
        const media = await MessageMedia.fromUrl(imageUrl);
        await client.sendMessage(jid, media, { caption: orderText });
        return;
      } catch (e) {
        console.error('[WA] Erreur envoi image produit:', e.message);
      }
    }
    await replyHuman(message, orderText);
  }

  async function confirmOrderWhatsApp(client, message, order, userId, username, { waveTransactionId = null } = {}) {
    const product = order.produit?.id ? await getProductById(order.produit.id) : null;
    const qteToDeduct = order.produit?.quantite ?? 1;
    const isVpn = (order.produit?.categorie || '').toLowerCase() === 'vpn';

    if (!isVpn && product?.catalogueId != null) {
      const deliveryData = await reserveCompteForOrder(order.produit.id);
      if (!deliveryData) {
        await updateOrderStatus(order.id, STATUS.ANNULEE);
        await replyHuman(message,msg.client.outOfStockCancelled(order.refCommande));
        return;
      }
      await updateOrderDeliveryData(order.id, {
        E: deliveryData.E,
        P: deliveryData.P,
        dateExpiration: deliveryData.dateExpiration,
      });
    } else if (order.produit?.id && qteToDeduct > 0 && !isVpn) {
      const productForStock = await getProductById(order.produit.id);
      const available = Math.max(0, productForStock?.stock ?? 0);
      if (available < qteToDeduct) {
        await updateOrderStatus(order.id, STATUS.ANNULEE);
        await replyHuman(message,msg.client.outOfStockCancelled(order.refCommande));
        return;
      }
      await decrementStock(order.produit.id, qteToDeduct);
    }

    await updateOrderStatus(order.id, STATUS.CONFIRMEE);
    if (waveTransactionId) await updateOrderWaveTransactionId(order.id, waveTransactionId);

    await replyHuman(message,msg.client.paymentReceived(order.refCommande));

    const qte = order.produit?.quantite ?? 1;
    const total = order.produit?.total ?? order.produit?.prix;
    const produitLine =
      qte > 1 ? `${order.produit.titre} x${qte} = ${total} FCFA` : `${order.produit.titre} — ${total} FCFA`;
    let adminText = `📦 [WhatsApp] Commande confirmée\nRef: ${order.refCommande}\nClient: ${username} (${userId})\nProduit: ${produitLine}`;
    if (waveTransactionId) adminText += `\n\n🆔 ID transaction Wave: ${waveTransactionId}`;
    if (isVpn) adminText += "\n\n🔐 Envoyer E, P et date d'expiration au client (via backoffice ou Telegram).";
    await notifyAdminTelegram(adminText);
  }

  client.initialize().catch((e) => {
    console.error('Erreur init WhatsApp:', e);
    process.exit(1);
  });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
