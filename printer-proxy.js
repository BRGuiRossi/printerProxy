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

// Wrapper para garantir que TODOS os logs exibam o aviso de não fechar
function safeLog(msg) {
    console.log(`\n${msg}\n${WARNING_MSG}`);
}

function addLog(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    safeLog(logMsg);
    logs.push(logMsg);
    if (logs.length > 100) logs.shift(); // Evita vazamento de memória
}

// --- EXPRESS ROUTES ---

app.get('/', (req, res) => {
    safeLog("[BROWSER STATUS] O Painel de Controle (Navegador) conectou ao proxy com sucesso!");
    res.send("Proxy da Impressora Lar Pizza está Online!");
});

app.post('/print', (req, res) => {
    const order = req.body;
    
    // Alerta sonoro do Windows para a cozinha
    try {
        exec('powershell -c "(New-Object Media.SoundPlayer \'C:\\Windows\\Media\\Notify.wav\').PlaySync()"', () => {});
    } catch (e) {
        // Ignora erros de audio para não travar
    }

    const safeOrderId = String(order.id || 'TESTE').slice(-5).toUpperCase();
    addLog(`[NOVO PEDIDO] Iniciando impressao: #${safeOrderId}`);
    pedidos.push(order);
    if (pedidos.length > 50) pedidos.shift();

    try {
        const device = new escpos.USB(VENDOR_ID, PRODUCT_ID);
        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) {
                const errorMsg = "Acesso negado ou impressora desligada.";
                addLog(`[ERRO USB] ${errorMsg} - ${err.message}`, true);
                return res.status(500).json({ error: errorMsg, details: err.message });
            }

            try {
                // Cabeçalho do Cupom
                printer
                    .font('a')
                    .align('ct')
                    .style('b')
                    .size(2, 2)
                    .text('LAR PIZZA')
                    .size(1, 1)
                    .style('normal')
                    .text('------------------------------------------------')
                    .align('lt')
                    .text(`PEDIDO : #${safeOrderId}`)
                    .text(`CLIENTE: ${order.customerName || 'Balcao / WhatsApp'}`)
                    .text('------------------------------------------------');

                // Itens Formatados
                const items = Array.isArray(order.items) ? order.items : [];
                items.forEach(item => {
                    const qty = String(item.quantity || 1).padStart(2, '0');
                    const name = String(item.name || 'Produto').substring(0, 28).padEnd(28, ' ');
                    const price = Number(item.price || 0).toFixed(2).padStart(7, ' ');
                    
                    printer
                        .align('lt')
                        .text(`${qty}x ${name} R$ ${price}`);
                });

                // Rodapé e Corte
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
                        addLog(`[SUCESSO] Pedido #${safeOrderId} impresso na cozinha.`);
                        res.status(200).json({ success: true, message: "Impresso com sucesso" });
                    });
                    
            } catch (printErr) {
                addLog(`[ERRO FORMATACAO] ${printErr.message}`, true);
                res.status(500).json({ error: "Erro ao formatar o cupom." });
            }
        });
    } catch (usbInitError) {
        addLog(`[ERRO DRIVER] Impressora nao encontrada. ${usbInitError.message}`, true);
        res.status(500).json({ error: "O driver da impressora falhou ao inicializar." });
    }
});

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

// Inicia o processo
startupSequence();