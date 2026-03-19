const express = require('express');
const cors = require('cors');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
const os = require('os');
const { exec } = require('child_process');
const readline = require('readline');

const app = express();
app.use(cors());
app.use(express.json());

const logs = [];
const pedidos = [];

// Epson TM-T20X II Default IDs
const VENDOR_ID = 0x04b8;
const PRODUCT_ID = 0x0e27;
const PORT = 3001;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const WARNING_MSG = "  *** ATENÇÃO: NÃO FECHE ESTA JANELA! ***";

function safeLog(msg) {
    console.log(`\n${msg}\n${WARNING_MSG}`);
}

function addLog(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
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
    printQueue.push({ order, res });
    processQueue(); // Trigger queue
});

// ASYNC QUEUE PROCESSOR
async function processQueue() {
    if (isPrinting || printQueue.length === 0) return;
    
    isPrinting = true;
    const job = printQueue.shift();
    const order = job.order;
    const safeOrderId = String(order.id || 'TESTE').slice(-5).toUpperCase();

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

// PRINTER EXECUTION WRAPPER
// << EXACT EXISTING CODE ABOVE >>
// PRINTER EXECUTION WRAPPER
function executePrint(order, safeOrderId) {
    return new Promise((resolve, reject) => {
        try {
            const device = new escpos.USB(VENDOR_ID, PRODUCT_ID);
            // MUDANÇA 1: Configura o Node.js para converter tudo para Latin-1 (Multilingual)
            const printer = new escpos.Printer(device, { encoding: "cp858" });

            device.open((err) => {
                if (err) {
                    return reject(new Error(`Acesso negado a porta USB: ${err.message}`));
                }

                try {
                    // Função de segurança: Se a impressora ignorar o encoding, removemos os acentos mais bizarros.
                    const limpaTexto = (str) => str ? String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';

                    printer
                        .encode('cp858') // MUDANÇA 2: Envia comando ESC/POS forçando a impressora a ler acentos
                        .font('a')
                        .align('ct')
                        .style('b')
                        .size(2, 2)
                       .text('LAR PIZZA')
                        .size(1, 1)
                        .style('normal')
                        .text('R. Cardoso 152 - Sta. Efigenia - BH')
                        .text('(31)99515-2921')
                        .text('========================================') // Separador Duplo
                        .feed(1);

                    const items = Array.isArray(order.items) ? order.items : [];
                    items.forEach(item => {
                        const qty = String(item.quantity || 1).padStart(2, '0');
                        // Aplica a limpeza de acentos e trunca para 28 caracteres
                        const name = limpaTexto(item.name || 'Produto').substring(0, 28).padEnd(28, ' ');
                        const price = Number(item.price || 0).toFixed(2).padStart(7, ' ');
                        
                        printer
                            .align('lt')
                            .text(`${qty}x ${name} R$ ${price}`);
                    });

                    printer
                        .text('------------------------------------------------')
                        .align('rt')
                        .size(1, 2)
                        .style('b')
                        .text(`TOTAL: R$ ${Number(order.total || 0).toFixed(2)}`)
                        .style('normal')
                        .size(1, 1)
                        .feed(3)
                        .cut()
                        .close(() => {
                            resolve();
                        });
                        
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
// << EXACT EXISTING CODE BELOW (Minimum 2 lines) >>

// PRINTER EXECUTION WRAPPER FOR TEEEEEEEEEEEEEEEEEEESSSSSSSSSSSSSTT  REAL ON ABOVE
function executePrint(order, safeOrderId) {
    return new Promise((resolve, reject) => {
        try {
            const device = new escpos.USB(VENDOR_ID, PRODUCT_ID);
            const printer = new escpos.Printer(device);

            device.open((err) => {
                if (err) {
                    return reject(new Error(`Acesso negado a porta USB: ${err.message}`));
                }

                try {
                    // Extrai a fonte (ex: "[iFood]") do nome do cliente, ou usa "[APP]" como fallback
                    const sourceLabel = order.customerName ? order.customerName.split(' ')[0] : '[APP]';
                    const timestamp = new Date().toLocaleString('pt-BR');

                    printer
                        .align('lt')
                        .size(1, 1)
                        .text(`TIME  : ${timestamp}`)
                        .text(`SOURCE: ${sourceLabel}`)
                        .feed(3)
                        .cut()
                        .close(() => {
                            resolve();
                        });
                        
                } catch (printErr) {
                    reject(new Error(`Erro ao formatar o cupom de teste: ${printErr.message}`));
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
        const device = new escpos.USB(VENDOR_ID, PRODUCT_ID);
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

function promptRetry() {
    rl.question('\n======================================================\n[ERRO] IMPRESSORA DESLIGADA OU DESCONECTADA!\n\n1. Verifique se a Epson TM-T20X esta ligada.\n2. Verifique se o cabo USB esta conectado.\n3. Pressione [ENTER] para testar novamente...\n======================================================\n', () => {
        startupSequence();
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
    ✅ IMPRESSORA : CONECTADA E PRONTA
    ⏳ NAVEGADOR  : AGUARDANDO CONEXAO (Abra o painel em http://${localIp}:${PORT})
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
    console.log("Iniciando Proxy Lar Pizza...");
    console.log("Verificando conexao USB com a impressora...\n");
    
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

startupSequence();