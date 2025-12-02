// -------------------------------------------------------------
// 🚀 API SALEH DIGITAL
// -------------------------------------------------------------
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// -------------------------------------------------------------
// 🔥 Firebase Admin
// -------------------------------------------------------------
try {
  const jsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const projectId = process.env.GCLOUD_PROJECT;

  const tempPath = path.join(os.tmpdir(), "firebase_key.json");
  fs.writeFileSync(tempPath, jsonString);

  admin.initializeApp({
    credential: admin.credential.cert(require(tempPath)),
    projectId
  });

  console.log("✅ Firebase conectado (Saleh Digital)");
} catch (err) {
  console.error("Firebase ERROR:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// -------------------------------------------------------------
// 🔠 Funções de normalização e similaridade de texto
// -------------------------------------------------------------
function normalizeString(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")                 // separa acentos
    .replace(/[\u0300-\u036f]/g, "")  // remove acentos
    .replace(/[^a-z0-9\s]/g, "")      // remove símbolos estranhos
    .replace(/\s+/g, " ")             // espaços múltiplos -> 1
    .trim();
}

function levenshtein(a, b) {
  a = normalizeString(a);
  b = normalizeString(b);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deleção
        dp[i][j - 1] + 1,      // inserção
        dp[i - 1][j - 1] + cost // substituição
      );
    }
  }

  return dp[m][n];
}

function similarityScore(a, b) {
  a = normalizeString(a);
  b = normalizeString(b);
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  // 1 = igual, 0 = totalmente diferente
  return 1 - dist / maxLen;
}


// -------------------------------------------------------------
// 🧂 PRODUTOS / ESTOQUE
// -------------------------------------------------------------

// Criar produto (insumo)
app.post("/products", async (req, res) => {
  try {
    const {
      description,
      unit,
      unitSize,
      unitPrice,
      yieldPercent = 100,
      notes = "",
      location = "",
      previousQuantity = 0,
      purchaseQuantity = 0,
      currentQuantity = 0
    } = req.body;

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("products").add({
      description,
      unit,
      unitSize,
      unitPrice,
      yieldPercent,
      notes,
      location,
      previousQuantity,
      purchaseQuantity,
      currentQuantity,
      createdAt: now,
      updatedAt: now
    });

    res.status(201).json({ id: docRef.id, message: "Produto criado" });
  } catch (err) {
    console.error("Erro /products POST:", err);
    res.status(500).json({ error: "Erro ao criar produto" });
  }
});


// Criar vários produtos em lote (só com descrição, unidade e preço)
app.post("/products/batch", async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : req.body.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Envie um array de produtos em 'items' ou um array direto no body" });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    items.forEach((item) => {
      const { description, unit, unitPrice } = item;

      // validação básica
      if (!description || !unit || unitPrice === undefined) {
        return; // pula linhas inválidas
      }

      const docRef = db.collection("products").doc();

      batch.set(docRef, {
        description,
        unit,
        unitPrice,

        // demais campos ficam "em branco" (padrão)
        unitSize: null,
        yieldPercent: null,
        notes: "",
        location: "",
        previousQuantity: 0,
        purchaseQuantity: 0,
        currentQuantity: 0,

        createdAt: now,
        updatedAt: now
      });
    });

    await batch.commit();

    res.status(201).json({
      message: "Produtos criados em lote com sucesso",
      total: items.length
    });
  } catch (err) {
    console.error("Erro /products/batch POST:", err);
    res.status(500).json({ error: "Erro ao criar produtos em lote" });
  }
});



// Listar produtos
app.get("/products", async (req, res) => {
  try {
    const snap = await db.collection("products").orderBy("description").get();
    const products = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json(products);
  } catch (err) {
    console.error("Erro /products GET:", err);
    res.status(500).json({ error: "Erro ao listar produtos" });
  }
});

// Registrar compra de um produto (atualiza histórico e estoque)
app.post("/products/:id/purchase", async (req, res) => {
  try {
    const productId = req.params.id;
    const { quantity, totalPrice, purchaseDate } = req.body; // quantity na unidade do produto

    const productRef = db.collection("products").doc(productId);
    const productSnap = await productRef.get();

    if (!productSnap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const product = productSnap.data();
    const previousQuantity = product.currentQuantity || 0;
    const currentQuantity = previousQuantity + quantity;

    const unitPrice = totalPrice / quantity;
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Adiciona no histórico (com estoque antes/depois)
    const purchaseRef = await productRef.collection("purchases").add({
      purchaseDate, // string "YYYY-MM-DD"
      quantity,
      totalPrice,
      unitPrice,
      stockBefore: previousQuantity,
      stockAfter: currentQuantity,
      createdAt: now
    });

    // Atualiza produto
    await productRef.update({
      previousQuantity,
      purchaseQuantity: quantity,
      currentQuantity,
      unitPrice,
      updatedAt: now
    });

    res.status(201).json({
      purchaseId: purchaseRef.id,
      message: "Compra registrada com sucesso"
    });
  } catch (err) {
    console.error("Erro /products/:id/purchase POST:", err);
    res.status(500).json({ error: "Erro ao registrar compra" });
  }
});

// Compra rápida: encontra (ou cria) produto por descrição + unidade
// Compra rápida: encontra (ou cria) produto por descrição + unidade, com busca por semelhança
app.post("/products/quick-purchase", async (req, res) => {
  try {
    const {
      description,
      unit,
      quantity,
      totalPrice,
      purchaseDate,
      supplier = ""
    } = req.body;

    if (!description || !unit || !quantity || !totalPrice) {
      return res.status(400).json({
        error: "Campos obrigatórios: description, unit, quantity, totalPrice"
      });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const unitPrice = totalPrice / quantity;
    const purchaseD =
      purchaseDate || new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    const THRESHOLD = 0.75; // 0.75 = 75% de "parecido"

    // 1) Tenta achar produto por descrição + unidade (igualzinho)
    let querySnap = await db
      .collection("products")
      .where("description", "==", description)
      .where("unit", "==", unit)
      .limit(1)
      .get();

    let productRef;
    let previousQuantity;
    let currentQuantity;
    let createdNew = false;

    if (querySnap.empty) {
      // 2) Não achou igualzinho -> procura por semelhança entre produtos com a mesma unidade
      const allSnap = await db
        .collection("products")
        .where("unit", "==", unit)
        .get();

      let bestDoc = null;
      let bestScore = 0;

      allSnap.forEach((doc) => {
        const data = doc.data();
        const score = similarityScore(description, data.description || "");
        if (score > bestScore) {
          bestScore = score;
          bestDoc = doc;
        }
      });

      if (bestDoc && bestScore >= THRESHOLD) {
        // 2a) Achou um produto bem parecido -> considera o mesmo produto
        productRef = bestDoc.ref;
        const product = bestDoc.data();
        previousQuantity = product.currentQuantity || 0;
        currentQuantity = previousQuantity + quantity;

        await productRef.update({
          previousQuantity,
          purchaseQuantity: quantity,
          currentQuantity,
          unitPrice,
          updatedAt: now
        });
      } else {
        // 2b) Nada parecido o suficiente -> cria produto novo
        productRef = db.collection("products").doc();
        previousQuantity = 0;
        currentQuantity = quantity;

        await productRef.set({
          description,
          unit,
          unitSize: null,
          unitPrice,
          yieldPercent: null,
          notes: "",
          location: "",
          previousQuantity,
          purchaseQuantity: quantity,
          currentQuantity,
          createdAt: now,
          updatedAt: now
        });

        createdNew = true;
      }
    } else {
      // 3) Já existe igualzinho -> usa o primeiro encontrado
      const doc = querySnap.docs[0];
      productRef = doc.ref;
      const product = doc.data();

      previousQuantity = product.currentQuantity || 0;
      currentQuantity = previousQuantity + quantity;

      await productRef.update({
        previousQuantity,
        purchaseQuantity: quantity,
        currentQuantity,
        unitPrice,
        updatedAt: now
      });
    }

    // 4) Registra histórico da compra (com estoque antes/depois)
    const purchaseRef = await productRef.collection("purchases").add({
      purchaseDate: purchaseD,
      quantity,
      totalPrice,
      unitPrice,
      supplier,
      stockBefore: previousQuantity,
      stockAfter: currentQuantity,
      createdAt: now
    });

    return res.status(201).json({
      message: "Compra registrada com sucesso (quick-purchase)",
      productId: productRef.id,
      purchaseId: purchaseRef.id,
      createdNewProduct: createdNew
    });
  } catch (err) {
    console.error("Erro /products/quick-purchase POST:", err);
    return res.status(500).json({ error: "Erro em quick-purchase" });
  }
});


// 🔍 Resumo do produto buscando por descrição + unidade (com busca por semelhança)
app.post("/products/summary-by-description", async (req, res) => {
  try {
    const { description, unit } = req.body;

    if (!description || !unit) {
      return res.status(400).json({
        error: "Campos obrigatórios: description e unit"
      });
    }

    const THRESHOLD = 0.75;

    // 1) Tenta achar produto por descrição + unidade (igualzinho)
    let querySnap = await db
      .collection("products")
      .where("description", "==", description)
      .where("unit", "==", unit)
      .limit(1)
      .get();

    let productRef;
    let product;

    if (querySnap.empty) {
      // 2) Não achou igualzinho -> faz busca por semelhança
      const allSnap = await db
        .collection("products")
        .where("unit", "==", unit)
        .get();

      let bestDoc = null;
      let bestScore = 0;

      allSnap.forEach((doc) => {
        const data = doc.data();
        const score = similarityScore(description, data.description || "");
        if (score > bestScore) {
          bestScore = score;
          bestDoc = doc;
        }
      });

      if (!bestDoc || bestScore < THRESHOLD) {
        return res.status(404).json({ error: "Produto não encontrado (nem parecido)" });
      }

      productRef = bestDoc.ref;
      product = { id: bestDoc.id, ...bestDoc.data(), similarity: bestScore };
    } else {
      // 3) Achou igualzinho
      const doc = querySnap.docs[0];
      productRef = doc.ref;
      product = { id: doc.id, ...doc.data(), similarity: 1 };
    }

    // 4) Buscar as 4 últimas compras
    const historySnap = await productRef
      .collection("purchases")
      .orderBy("purchaseDate", "desc")
      .limit(4)
      .get();

    const lastPurchases = [];
    let somaPrecos = 0;
    let contador = 0;

    historySnap.forEach((h) => {
      const data = h.data();
      lastPurchases.push({
        id: h.id,
        ...data
      });

      if (typeof data.unitPrice === "number") {
        somaPrecos += data.unitPrice;
        contador += 1;
      }
    });

    const avgLast4UnitPrice = contador > 0 ? somaPrecos / contador : null;

    return res.json({
      product,
      lastPurchases,
      avgLast4UnitPrice
    });
  } catch (err) {
    console.error("Erro em POST /products/summary-by-description", err);
    return res.status(500).json({ error: "Erro ao buscar resumo por descrição" });
  }
});



// 📜 Histórico de compras de um produto
app.get("/products/:id/history", async (req, res) => {
  try {
    const id = req.params.id;
    const productRef = db.collection("products").doc(id);

    // Aqui eu assumo que na rota /purchase você salvou em "purchases"
    const historySnap = await productRef
      .collection("purchases")
      .orderBy("purchaseDate", "desc")
      .get();

    const history = historySnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(history);
  } catch (err) {
    console.error("Erro em GET /products/:id/history", err);
    res.status(500).json({ error: "Erro ao buscar histórico" });
  }
});


// 🔍 Resumo completo do produto + média dos últimos 4 preços
app.get("/products/:id/summary", async (req, res) => {
  try {
    const id = req.params.id;
    const productRef = db.collection("products").doc(id);
    const productSnap = await productRef.get();

    if (!productSnap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const product = { id: productSnap.id, ...productSnap.data() };

    // Busca as 4 últimas compras (ordenadas por data)
    const historySnap = await productRef
      .collection("purchases")
      .orderBy("purchaseDate", "desc")
      .limit(4)
      .get();

    const lastPurchases = [];
    let somaPrecos = 0;
    let contador = 0;

    historySnap.forEach((doc) => {
      const data = doc.data();
      lastPurchases.push({
        id: doc.id,
        ...data
      });

      if (typeof data.unitPrice === "number") {
        somaPrecos += data.unitPrice;
        contador += 1;
      }
    });

    const avgLast4UnitPrice = contador > 0 ? somaPrecos / contador : null;

    return res.json({
      product,          // todos os campos do produto
      lastPurchases,    // último até 4 registros de compras
      avgLast4UnitPrice // média dos últimos 4 unitPrice
    });
  } catch (err) {
    console.error("Erro em GET /products/:id/summary", err);
    return res.status(500).json({ error: "Erro ao buscar resumo do produto" });
  }
});


// 🔄 Atualizar um produto (ex: corrigir descrição)
app.patch("/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    const docRef = db.collection("products").doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    // Só atualiza os campos que vierem no body
    const camposPermitidos = [
      "description",
      "unit",
      "unitSize",
      "unitPrice",
      "yieldPercent",
      "notes",
      "location"
    ];

    const updateData = {};
    camposPermitidos.forEach((campo) => {
      if (body[campo] !== undefined) {
        updateData[campo] = body[campo];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar" });
    }

    await docRef.update(updateData);

    const updated = await docRef.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    console.error("Erro em PATCH /products/:id", err);
    res.status(500).json({ error: "Erro ao atualizar produto" });
  }
});


// -------------------------------------------------------------
// 🍽️ PEDIDOS (GARÇOM / COZINHA / NICOCHAT)
// -------------------------------------------------------------

// Criar novo pedido
app.post("/orders", async (req, res) => {
  try {
    const {
      tableNumber,
      customerName,
      channel,
      items,
      notes = ""
    } = req.body;

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("orders").add({
      tableNumber,
      customerName,
      channel,           // "garcom" | "nicochat" | "app"
      status: "pendente",
      items,
      notes,
      createdAt: now,
      updatedAt: now
    });

    res.status(201).json({ id: docRef.id, message: "Pedido criado" });
  } catch (err) {
    console.error("Erro /orders POST:", err);
    res.status(500).json({ error: "Erro ao criar pedido" });
  }
});

// Listar pedidos por status (versão simples, sem índice)
app.get("/orders", async (req, res) => {
  try {
    const status = req.query.status || "pendente";

    // Tira o orderBy para não precisar de índice composto
    const snap = await db
      .collection("orders")
      .where("status", "==", status)
      .get();

    const orders = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(orders);
  } catch (err) {
    console.error("Erro /orders GET:", err);
    res.status(500).json({ error: "Erro ao listar pedidos" });
  }
});


// Consultar status de um pedido
app.get("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const snap = await db.collection("orders").doc(orderId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("Erro /orders/:id GET:", err);
    res.status(500).json({ error: "Erro ao buscar pedido" });
  }
});

// -------------------------------------------------------------
// 👥 CLIENTES / CRM
// -------------------------------------------------------------

// Criar ou atualizar cliente
app.post("/customers", async (req, res) => {
  try {
    const {
      name,
      phone,
      channel = "presencial", // garcom | nicochat | app | presencial
      notes = ""
    } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Telefone (phone) é obrigatório" });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = db.collection("customers").doc(phone);
    const snap = await docRef.get();

    if (snap.exists) {
      // atualiza
      await docRef.update({
        name,
        channel,
        notes,
        updatedAt: now
      });
      const updated = await docRef.get();
      return res.json({ id: updated.id, ...updated.data() });
    } else {
      // cria
      await docRef.set({
        name,
        phone,
        channel,
        notes,
        createdAt: now,
        updatedAt: now
      });
      const created = await docRef.get();
      return res.status(201).json({ id: created.id, ...created.data() });
    }
  } catch (err) {
    console.error("Erro /customers POST:", err);
    res.status(500).json({ error: "Erro ao salvar cliente" });
  }
});

// Listar clientes (limit 200)
app.get("/customers", async (req, res) => {
  try {
    const snap = await db
      .collection("customers")
      .orderBy("name")
      .limit(200)
      .get();

    const customers = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(customers);
  } catch (err) {
    console.error("Erro /customers GET:", err);
    res.status(500).json({ error: "Erro ao listar clientes" });
  }
});

// Buscar cliente por telefone
app.get("/customers/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const snap = await db.collection("customers").doc(phone).get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Cliente não encontrado" });
    }
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("Erro /customers/:phone GET:", err);
    res.status(500).json({ error: "Erro ao buscar cliente" });
  }
});


// -------------------------------------------------------------
// 🚀 Rota raiz
// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Saleh Digital API está no ar ✅");
});

app.listen(PORT, () => {
  console.log(`🔥 Saleh Digital API rodando na porta ${PORT}`);
});
