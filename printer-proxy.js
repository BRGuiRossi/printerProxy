const express = require('express');
const cors = require('cors');
const escpos = require('escpos');
escpos.Network = require('escpos-network');
const os = require('os');
const { exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// EVITA QUE A JANELA FECHE SOZINHA EM CASO DE ERRO FATAL
process.on('uncaughtException', (err) => {
    console.error('\n======================================================');
    console.error('[ERRO FATAL] O aplicativo encontrou um problema crítico:');
    console.error(err.message || err);
    console.error('======================================================\n');
    console.log('Pressione ENTER para fechar a janela...');
    const rlFallback = readline.createInterface({ input: process.stdin, output: process.stdout });
    rlFallback.question('', () => process.exit(1));
});

const app = express();
app.use(cors());
app.use(express.json());

const logs = [];
const pedidos = [];

// ==========================================
// CONFIGURAÇÃO DA IMPRESSORA DE REDE
// ==========================================
let PRINTER_IP = ''; // Será preenchido dinamicamente
const PRINTER_PORT = 9100;
const PORT = 3001;

// Ajuste para funcionar dentro do .exe compilado pelo pkg (salva na mesma pasta do .exe)
const isCompiled = typeof process.pkg !== 'undefined';
const basePath = isCompiled ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(basePath, 'printer-config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return data.printerIp || '';
        }
    } catch (e) {}
    return '';
}

function saveConfig(ip) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ printerIp: ip }));
}

// ==========================================
// DADOS DO ESTABELECIMENTO
// Edite aqui caso mude endereço ou telefone
// ==========================================
const STORE_NAME    = 'LAR PIZZA';
const STORE_ADDRESS = 'Rua Cardoso, 152 - Belo Horizonte/MG';
const STORE_PHONE   = '(31) 99515-2921';
// ==========================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const WARNING_MSG = "  *** ATENÇÃO: NÃO FECHE ESTA JANELA! ***";

function safeLog(msg) {
    console.log(`\n${msg}\n${WARNING_MSG}`);
}

function addLog(msg, isError = false) {
    // Robust Time Formatting (No ICU/Intl Dependencies)
    const agora = new Date();
    const hora = String(agora.getHours()).padStart(2, '0');
    const min = String(agora.getMinutes()).padStart(2, '0');
    const sec = String(agora.getSeconds()).padStart(2, '0');
    const time = `${hora}:${min}:${sec}`;
    
    const logMsg = `[${time}] ${msg}`;
    safeLog(logMsg);
    logs.push(logMsg);
    if (logs.length > 100) logs.shift(); // Keep memory clean
}

let isPrinting = false;
const printQueue = [];

app.get('/', (req, res) => {
    safeLog("[BROWSER STATUS] O Painel de Controle (Navegador) conectou ao proxy com sucesso!");
    res.send("Proxy da Impressora Lar Pizza está Online!");
});

// ROUTE: Add to Queue
app.post('/print', (req, res) => {
    const order = req.body;
    // Use iFood shortCode when available, fall back to last 6 chars of id
    const safeOrderId = limpaTextoRaw(order.shortCode || String(order.id || 'TESTE').slice(-6).toUpperCase());
    printQueue.push({ order, safeOrderId, res });
    processQueue();
});

// ASYNC QUEUE PROCESSOR
async function processQueue() {
    if (isPrinting || printQueue.length === 0) return;
    
    isPrinting = true;
    const job = printQueue.shift();
    const order = job.order;
    const safeOrderId = job.safeOrderId || limpaTextoRaw(String(order.id || 'TESTE').slice(-6).toUpperCase());

    // Windows Sound Alert
    try {
        exec('powershell -c "(New-Object Media.SoundPlayer \'C:\\Windows\\Media\\Notify.wav\').PlaySync()"', () => {});
    } catch (e) {}

    addLog(`[FILA] Iniciando impressao: #${safeOrderId} (Restam: ${printQueue.length})`);
    pedidos.push(order);
    if (pedidos.length > 50) pedidos.shift();

    try {
        await executePrint(order, safeOrderId);
        addLog(`[SUCESSO] Pedido #${safeOrderId} impresso.`);
        job.res.status(200).json({ success: true, message: "Impresso com sucesso" });
    } catch (error) {
        addLog(`[ERRO] Falha no pedido #${safeOrderId}: ${error.message}`, true);
        job.res.status(500).json({ error: error.message });
    } finally {
        isPrinting = false;
        // Wait 1.5 seconds before processing the next ticket to allow USB buffer to clear
        setTimeout(processQueue, 1500);
    }
}

// Stateless helper used before device opens (for safeOrderId in /print route)
function limpaTextoRaw(str) {
    if (!str) return '';
    return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\r\n]/g, '');
}

/**
 * parseOrderDate — handles every format createdAt can arrive as:
 *   - Firestore Timestamp object   { _seconds, _nanoseconds }
 *   - Firestore Timestamp (live)   { toDate: Function }
 *   - ISO string                   "2024-01-01T20:00:00.000Z"
 *   - Unix ms (number)
 *   - Already a Date
 *   - null / undefined  → "Nao informado"
 */
function parseOrderDate(createdAt) {
    if (!createdAt) return null;
    try {
        if (typeof createdAt.toDate === 'function') return createdAt.toDate();
        // Firestore Admin SDK serializes as { _seconds, _nanoseconds }
        if (createdAt._seconds !== undefined) return new Date(createdAt._seconds * 1000);
        // Firestore Client SDK serializes as { seconds, nanoseconds } (no underscore)
        if (createdAt.seconds !== undefined) return new Date(createdAt.seconds * 1000);
        if (createdAt instanceof Date) return createdAt;
        const d = new Date(createdAt);
        return isNaN(d.getTime()) ? null : d;
    } catch (e) {
        return null;
    }
}

function formatDateTime(createdAt) {
    const d = parseOrderDate(createdAt);
    if (!d) return 'Nao informado';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// PRINTER EXECUTION WRAPPER
// PRINTER EXECUTION WRAPPER (Padrão iFood)
function executePrint(order, safeOrderId) {
    return new Promise((resolve, reject) => {
        try {
            const device = new escpos.Network(PRINTER_IP, PRINTER_PORT);
            const printer = new escpos.Printer(device, { encoding: "cp858" });

            device.open((err) => {
                if (err) return reject(new Error(`Falha ao conectar no IP ${PRINTER_IP}: ${err.message}`));

                try {
                    const limpaTexto = (str) => {
                        if (!str) return '';
                        return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\r\n]/g, '');
                    };

                    // Format address — iFood can send either a plain string or an object
                    const formatAddress = (addr) => {
                        if (!addr) return 'Nao informado';
                        if (typeof addr === 'string') return limpaTexto(addr);
                        return limpaTexto(
                            [addr.street, addr.number, addr.complement, addr.neighborhood, addr.city, addr.state]
                            .filter(Boolean).join(', ')
                        );
                    };

                    const isPickup = order.shippingMethod === 'pickup' || order.deliveryType === 'pickup';
                    const orderDate = formatDateTime(order.createdAt);
                    
                    printer.encode('cp858').font('a');

                    // ==========================================
                    // 0. CABECALHO DO ESTABELECIMENTO
                    // ==========================================
                    printer.align('ct').style('b').size(1, 2);
                    printer.text(STORE_NAME);
                    printer.size(1, 1).style('normal');
                    printer.text(STORE_ADDRESS);
                    printer.text(`Tel: ${STORE_PHONE}`);
                    printer.text('------------------------------------------------');
                    printer.text(`iFood #${safeOrderId}`);
                    printer.size(1, 1).style('normal');
                    printer.text(isPickup ? '>>> PARA RETIRADA <<<' : '>>> PARA ENTREGA <<<');

                    // AGENDADO — banner crítico para a cozinha
                    if (order.isScheduled && order.scheduledTime) {
                        printer.feed(1).style('b').size(1, 2).align('ct');
                        printer.text('*** PEDIDO AGENDADO ***');
                        printer.size(1, 1);
                        printer.text(`ENTREGAR AS: ${limpaTexto(order.scheduledTime)}`);
                        printer.style('normal');
                    }

                    printer.text('------------------------------------------------');

                    // ==========================================
                    // 2. DADOS DO CLIENTE
                    // ==========================================
                    printer.align('lt').style('b');
                    printer.text(`Cliente: ${limpaTexto(order.customerName || 'Nao Informado')}`);
                    printer.style('normal');
                    if (order.customerPhone) printer.text(`Telefone: ${limpaTexto(order.customerPhone)}`);
                    if (order.customerDocument) printer.text(`CPF/CNPJ: ${limpaTexto(order.customerDocument)}`);
                    if (order.pickupCode) {
                        printer.feed(1).style('b').size(2, 2).align('ct');
                        printer.text(`COD: ${limpaTexto(order.pickupCode)}`);
                        printer.size(1, 1).style('normal').align('lt');
                    }
                    printer.text('------------------------------------------------');

                    // ==========================================
                    // 3. DADOS DE ENTREGA (Se aplicável)
                    // ==========================================
                    if (!isPickup) {
                        printer.style('b').text('ENDERECO DE ENTREGA:').style('normal');
                        printer.text(formatAddress(order.deliveryAddress));
                        
                        if (order.deliveryObservations) {
                            printer.feed(1).style('b').text('OBSERVACOES P/ ENTREGADOR:');
                            printer.style('normal').text(limpaTexto(order.deliveryObservations));
                        }
                        printer.text('------------------------------------------------');
                    }

                    // ==========================================
                    // 4. ITENS DO PEDIDO
                    // ==========================================
                    printer.style('b').text('Qtd   Item                              Preco').style('normal');
                    printer.text('------------------------------------------------');
                    
                    const items = Array.isArray(order.items) ? order.items : [];
                    items.forEach(item => {
                        const qty = String(item.quantity || 1).padStart(2, '0');
                        const rawName = limpaTexto(item.name || 'Produto');
                        const name = rawName.substring(0, 32).padEnd(32, ' ');
                        const price = Number(item.price || 0).toFixed(2).padStart(7, ' ');
                        
                        printer.style('b').text(`${qty}x ${name} R$ ${price}`).style('normal');
                        
                        if (item.details) {
                            printer.text(`   -> ${limpaTexto(item.details)}`);
                        }
                    });
                    printer.text('------------------------------------------------');

                    // ==========================================
                    // 5. OBSERVAÇÕES DE PREPARO (COZINHA)
                    // ==========================================
                    if (order.observations) {
                        printer.style('b').text('OBSERVACOES DA COZINHA:');
                        printer.style('normal').text(limpaTexto(order.observations));
                        printer.text('------------------------------------------------');
                    }

                    // ==========================================
                    // 6. DETALHAMENTO FINANCEIRO E PAGAMENTO
                    // ==========================================
                    printer.align('rt');
                    printer.text(`Subtotal: R$ ${Number(order.subtotal || 0).toFixed(2)}`);
                    if (order.deliveryFee > 0) printer.text(`Taxa Entrega: R$ ${Number(order.deliveryFee).toFixed(2)}`);
                    
                    if (order.discountAmount > 0) {
                        const sponsor = limpaTexto(order.discountSponsor) === 'IFOOD' ? 'iFood' : 'Loja';
                        printer.text(`Desconto (${sponsor}): -R$ ${Number(order.discountAmount).toFixed(2)}`);
                    }

                    printer.style('b').size(1, 1);
                    printer.text(`TOTAL: R$ ${Number(order.totalPrice || order.total || 0).toFixed(2)}`);
                    printer.style('normal').size(1, 1).align('lt');
                    printer.text('------------------------------------------------');

                    printer.align('ct').style('b');
                    const paymentMethod = limpaTexto(order.paymentMethod || 'NAO INFORMADO').toUpperCase();
                    printer.text(`PAGAMENTO: ${paymentMethod}`);
                    
                    if (paymentMethod.includes('DINHEIRO') && order.changeFor > 0) {
                        const troco = order.changeFor - (order.totalPrice || order.total || 0);
                        printer.feed(1);
                        printer.text(`LEVAR TROCO PARA R$ ${Number(order.changeFor).toFixed(2)}`);
                        printer.text(`(TROCO: R$ ${troco.toFixed(2)})`);
                    }

                    // CUT & CLOSE
                    printer.align('ct').style('normal');
                    printer.text('------------------------------------------------');
                    printer.text(`Pedido via iFood  ${orderDate}`);
                    printer.feed(1).text('Obrigado pela preferencia!');
                    printer.feed(4).cut().close(() => { resolve(); });
                        
                } catch (printErr) {
                    reject(new Error(`Erro ao formatar o cupom: ${printErr.message}`));
                }
            });
        } catch (usbInitError) {
            reject(new Error(`Driver nao encontrado: ${usbInitError.message}`));
        }
    });
}

app.get('/logs', (req, res) => res.json(logs));
app.get('/pedidos', (req, res) => res.json(pedidos));

// --- STARTUP & CONNECTION CHECK SEQUENCE ---

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break;
            }
        }
    }
    return localIp;
}

function testPrinterConnection(callback) {
    try {
        const device = new escpos.Network(PRINTER_IP, PRINTER_PORT);
        device.open((err) => {
            if (err) {
                return callback(false, err.message);
            }
            device.close(); // Fecha a porta para liberar para o Express
            return callback(true);
        });
    } catch (err) {
        return callback(false, err.message);
    }
}

function promptForIp() {
    rl.question('\n👉 Digite o IP da sua impressora Epson (ex: 192.168.1.200): ', (ip) => {
        if (!ip || ip.trim() === '') return promptForIp();
        PRINTER_IP = ip.trim();
        console.log(`\nTestando conexao com ${PRINTER_IP}...`);
        
        testPrinterConnection((success, errorMsg) => {
            if (success) {
                saveConfig(PRINTER_IP);
                safeLog("✅ Impressora conectada e IP salvo com sucesso!");
                if (!serverStarted) startServer();
                else printReadyScreen();
            } else {
                safeLog(`❌ Falha ao conectar no IP ${PRINTER_IP}: ${errorMsg}`);
                promptForIp();
            }
        });
    });
}

function promptRetry() {
    rl.question(`\n======================================================\n[ERRO] IMPRESSORA DE REDE INACESSÍVEL!\n\n1. Tentar conectar novamente no IP salvo (${PRINTER_IP}) [Pressione ENTER]\n2. Digitar um NOVO IP (Digite 'N' e pressione ENTER)\n======================================================\n> `, (answer) => {
        if (answer.trim().toUpperCase() === 'N') {
            promptForIp();
        } else {
            startupSequence();
        }
    });
}

let serverStarted = false;

function printReadyScreen() {
    const localIp = getLocalIp();
    console.clear();
    safeLog(`
    ███████╗██╗   ██╗ █████╗ ████████╗███████╗    ██████╗ ███████╗██╗   ██╗
    ██╔════╝██║   ██║██╔══██╗╚══██╔══╝██╔════╝    ██╔══██╗██╔════╝██║   ██║
    ███████╗██║   ██║███████║   ██║   █████╗      ██████╔╝█████╗  ██║   ██║
    ╚════██║██║   ██║██╔══██║   ██║   ██╔══╝      ██╔══██╗██╔══╝  ██║   ██║
    ███████║╚██████╔╝██║  ██║   ██║   ███████╗    ██║  ██║███████╗╚██████╔╝
    ╚══════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝    ╚═╝  ╚═╝╚══════╝ ╚═════╝ 

    [STATUS DO SISTEMA]
    ✅ IMPRESSORA : CONECTADA NA REDE IP: ${PRINTER_IP}
    ⏳ NAVEGADOR  : AGUARDANDO CONEXAO (Mantenha o painel apontado para localhost ou ${localIp})
    `);
}

function startServer() {
    app.listen(PORT, '0.0.0.0', () => {
        serverStarted = true;
        printReadyScreen();
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            safeLog(`[ERRO CRITICO] A porta ${PORT} ja esta em uso. O proxy ja esta aberto em outra janela?`);
        } else {
            safeLog(`[ERRO SERVIDOR] ${err.message}`);
        }
        process.exit(1);
    });
}

function startupSequence() {
    console.clear();
    console.log("Iniciando Proxy Lar Pizza...\n");
    
    PRINTER_IP = loadConfig();
    
    if (!PRINTER_IP) {
        console.log("Nenhum IP de impressora configurado anteriormente.");
        promptForIp();
    } else {
        console.log(`Verificando conexao com o IP salvo: ${PRINTER_IP}...\n`);
        testPrinterConnection((success, errorMsg) => {
            if (!success) {
                safeLog(`Falha na comunicacao com o hardware: ${errorMsg}`);
                promptRetry();
            } else {
                safeLog("Impressora detectada com sucesso!");
                if (!serverStarted) {
                    startServer();
                } else {
                    printReadyScreen();
                }
            }
        });
    }
}

startupSequence();