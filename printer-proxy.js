// Strict Integration: printer-proxy.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import escpos from 'escpos';
import usb from 'escpos-usb';

const app = express();
app.use(cors());
app.use(bodyParser.json());

// CONFIGURAÇÃO DA IMPRESSORA EPSON TM-T20X
const VENDOR_ID = 0x04b8; // Epson
const PRODUCT_ID = 0x0e15; // TM-T20X

// Fila de impressão
let printQueue = [];
let isPrinting = false;

// Função auxiliar para remover acentos e caracteres especiais para impressora thermal
function limpaTexto(text) {
    if (!text) return '';
    return String(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .replace(/[^a-zA-Z0-9\s#,.():/-]/g, ""); // Mantém apenas alfanuméricos e pontuação básica
}

// === FIX 1: Função Auxiliar de Formatação de Colunas (Matrix de Itens) ===
// Assume papel de 40 caracteres de largura (Standard para TM-T20X)
function formatarLinhaItem(qtd, nome, valor) {
    const limQtd = 4; // Largura da coluna Qtd
    const limValor = 10; // Largura da coluna Valor ("R$ XXX,XX")
    const limNome = 40 - limQtd - limValor - 6; // Sobra 20 para o nome (40 total - larguras - 2 separadores ' | ')

    const strQtd = limpaTexto(qtd.toString()).padEnd(limQtd, ' ');
    const strNome = limpaTexto(nome).substring(0, limNome).padEnd(limNome, ' ');
    const strValor = `R$ ${parseFloat(valor).toFixed(2)}`.padEnd(limValor, ' ');

    return `${strQtd} | ${strNome} | ${strValor}`;
}

async function processQueue() {
    if (isPrinting || printQueue.length === 0) return;
    isPrinting = true;
    const task = printQueue.shift();

    try {
        await executePrint(task.order, task.safeOrderId);
        console.log(`[PRINT SUCCESS] Pedido impresso: ${task.safeOrderId}`);
    } catch (error) {
        console.error(`[PRINT ERROR] Falha ao imprimir ${task.safeOrderId}:`, error.message);
    } finally {
        isPrinting = false;
        processQueue(); // Próximo item
    }
}

async function executePrint(order, safeOrderId) {
    return new Promise((resolve, reject) => {
        let device;
        let printer;

        // Instancia a conexão USB por requisição para evitar Crash Global de hardware offline
        try {
            device = new escpos.USB(VENDOR_ID, PRODUCT_ID);
            printer = new escpos.Printer(device);
        } catch (usbInitError) {
            return reject(new Error(`Falha ao conectar cabo USB da impressora: ${usbInitError.message}`));
        }

        try {
            device.open((error) => {
                if (error) {
                    return reject(error);
                }

                try {
                    printer.encode('cp858'); // Normalização para português/acentos

                    // === HEADER (Logo e dynamic Source) ===
                    printer
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

                    // FIX 2: Dynamic Source Injection (e.g., PEDIDO IFOOD #12345)
                    let headerText = 'PEDIDO';
                    if (order.source && order.source.toLowerCase().includes('ifood')) headerText += ' IFOOD';
                    else if (order.source && order.source.toLowerCase().includes('site')) headerText += ' SITE';
                    else if (order.source && order.source.toLowerCase().includes('whatsapp')) headerText += ' WHATSAPP';
                    else if (order.id && order.id.startsWith('ifood-')) headerText += ' IFOOD'; // Fallback logic based on uploaded server.js example
                    else if (order.customerPhone && !order.customerId) headerText += ' WHATSAPP';
                    else headerText += ' LOCAL';
                    
                    headerText += ` #${safeOrderId}`;

                    printer
                        .style('b')
                        .size(1, 2) // Double Height only for clarity
                        .text(limpaTexto(headerText))
                        .size(1, 1)
                        .style('normal')
                        .feed(1);

                    // Date and CID logic
                    const agora = new Date();
                    const dataFmt = agora.toLocaleDateString('pt-BR');
                    const horaFmt = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const cidStr = order.customerId ? `(Cid: ${order.customerId.substring(0, 5)})` : '(Cid: Conv.)';
                    
                    printer
                        .text(`${dataFmt} ${horaFmt} ${cidStr}`)
                        .text('----------------------------------------') // Separador Simples
                        .feed(1);

                    // === SECTION: CLIENTE ===
                    printer
                        .align('lt')
                        .style('b')
                        .text('* CLIENTE *')
                        .style('normal')
                        .feed(1)
                        .text(limpaTexto(order.customerName || 'Cliente Consumidor'))
                        .text(limpaTexto(order.deliveryAddress || 'Retirada no Local'));

                    if (order.addressContext || order.deliveryContext) {
                        printer.text(`(${limpaTexto(order.addressContext || order.deliveryContext)})`);
                    }
                    if (order.customerPhone) {
                        printer.text(limpaTexto(order.customerPhone));
                    }
                    
                    printer
                        .feed(1)
                        .text('----------------------------------------')
                        .feed(1);

                    // === SECTION: ITENS DO PEDIDO (Matrix com Alinhamento Fixado) ===
                    printer
                        .style('b')
                        .text('* ITENS DO PEDIDO *')
                        .style('normal')
                        .feed(1);

                    // Cabeçalhos da Matrix
                    printer.text('Qtd  | Item                  | Valor     ');
                    printer.text('----------------------------------------');

                    // Loop através dos itens usando formatarLinhaItem (FIX 3)
                    if (Array.isArray(order.items) && order.items.length > 0) {
                        order.items.forEach((item) => {
                            const qtd = item.quantity || 1;
                            const nome = item.name || item.title || 'Produto Lar Pizza';
                            const valor = item.price || item.unit_price || 0;
                            
                            printer.text(formatarLinhaItem(qtd, nome, valor));
                        });
                    } else {
                        printer.text('Nenhum item informado.');
                    }
                    
                    printer
                        .feed(1)
                        .text('----------------------------------------');

                    // === SECTION: RESUMO E TOTAL ===
                    // Subtotal
                    if (order.subtotal) {
                        printer
                            .align('rt')
                            .text(`Subtotal: R$ ${parseFloat(order.subtotal).toFixed(2)}`);
                    }
                    // Taxa de Entrega (Do iFood/Google Maps)
                    if (order.deliveryFee) {
                        printer
                            .align('rt')
                            .text(`Taxa de Entrega: R$ ${parseFloat(order.deliveryFee).toFixed(2)}`);
                    }
                    
                    printer.feed(1);

                    // TOTAL DO PEDIDO (Grande e Centralizado)
                    const totalText = `R$ ${parseFloat(order.totalPrice || 0).toFixed(2)}`;
                    printer
                        .align('ct')
                        .style('b')
                        .size(2, 2)
                        .text('TOTAL DO PEDIDO')
                        .text(totalText)
                        .size(1, 1)
                        .style('normal')
                        .feed(1)
                        .text('----------------------------------------')
                        .feed(1);

                    // === FIX 4: SECTION SEPARADA - ENTREGA E PAGAMENTO ===
                    printer
                        .align('lt')
                        .style('b')
                        .text('* ENTREGA E PAGAMENTO *')
                        .style('normal')
                        .feed(1);

                    // Detalhes do Pagamento (Lógica condicional)
                    let pmtMethod = 'Forma de Pagamento Nao Informada';
                    if (order.paymentMethod === 'credit_card') pmtMethod = 'PAGAMENTO: Cartao de Credito';
                    else if (order.paymentMethod === 'debit_card') pmtMethod = 'PAGAMENTO: Cartao de Debito';
                    else if (order.paymentMethod === 'pix' || order.source === 'ifood') pmtMethod = `PAGAMENTO: PIX/iFood (Pre-pago)`;
                    else if (order.paymentMethod === 'cash') pmtMethod = `PAGAMENTO: Dinheiro na Entrega`;
                    
                    printer.text(limpaTexto(pmtMethod));

                    // Detalhes da Entrega/Retirada
                    let deliveryStr = 'ENTREGA: Moto Entregador';
                    if (!order.deliveryAddress || order.deliveryMethod === 'pickup') {
                        deliveryStr = 'CONTEXTO: Retirada no Local';
                    }
                    printer.text(limpaTexto(deliveryStr));

                    printer
                        .feed(1)
                        .text('----------------------------------------')
                        .feed(1);

                    // === FOOTER (Observações e Agradecimento) ===
                    if (order.observations || order.customerNotes) {
                        printer
                            .align('lt')
                            .style('b')
                            .text('* Observacao:*')
                            .style('normal')
                            .text(limpaTexto(order.observations || order.customerNotes))
                            .feed(1);
                    }

                    printer
                        .align('ct')
                        .text('Muito obrigado por escolher a Lar Pizza!')
                        .feed(1);

                    if (order.source === 'ifood') {
                        printer.text('Pedido iFood confirmado.');
                    } else if (order.source === 'lar-pizza.web.app' || order.larPizzaAppOrderId) {
                        printer.text('Pedido feito pelo site lar-pizza.web.app');
                    }

                    // Correção de Asincronicidade e Fechamento Seguro
                    printer.feed(2).cut();
                    
                    printer.close(() => {
                        resolve();
                    });

                } catch (err) {
                    if (device) {
                        device.close(() => {});
                    }
                    reject(err);
                }
            });
        } catch (openError) {
            reject(openError);
        }
    });
}

// === ROTAS DA API ===
app.post('/print', (req, res) => {
    const orderData = req.body;
    
    if (!orderData || !orderData.id) {
        return res.status(400).send('Dados insuficientes do pedido.');
    }

    const safeOrderId = String(orderData.id).substring(0, 10).toUpperCase();

    // Adiciona à fila
    printQueue.push({ order: orderData, safeOrderId });
    processQueue(); // Tenta iniciar processamento

    res.status(200).send({ 
        success: true, 
        message: `Pedido #${safeOrderId} adicionado a fila de impressao.`
    });
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`[PRINTER PROXY] 🖨️ Servidor rodando em http://localhost:${PORT}`);
    console.log(`[PRINTER PROXY] Conecte a Epson TM-T20X via USB.`);
});