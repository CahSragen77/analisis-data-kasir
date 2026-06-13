// Global State Storage
let globalData = null;
let paymentChartInstance = null;

// Page Router Switcher
function switchPage(pageId) {
    $('.erp-page').addClass('d-none');
    $('#sidebar .nav-link').removeClass('active');
    
    $(`#page-${pageId}`).removeClass('d-none');
    $(`[onclick="switchPage('${pageId}')"]`).addClass('active');
}

// Format Currency to IDR Standard
function formatIDR(value) {
    if (value === undefined || value === null || isNaN(value)) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(value);
}

// File Upload Handler
$('#sqlUpload').on('change', function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const rawSql = e.target.result;
        globalData = parseSQLDump(rawSql);
        
        // Render data component
        populateDashboardMetrics(globalData);
        calculateAndRenderPnL(globalData); // Memanggil kalkulasi Laba Rugi otomatis
        
        $('#exportAllBtn').prop('disabled', false);
        $('#storeIndicator').text(`Store Data Loaded`).removeClass('bg-secondary').addClass('bg-success');
        alert(`Berhasil memuat data ERP dari SQL Dump!`);
    };
    reader.readAsText(file, 'UTF-8');
});

// PostgreSQL COPY input parser logic (Diadopsi dari analisis Data Kasir.html)
function parseSQLDump(text) {
    const database = { c_trans: [], c_tsale: [], m_cust: [], m_loader: [], cek_eod: [] };
    const lines = text.split(/\r?\n/);
    let currentTable = null, columns = [], inCopy = false, buffer = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let copyMatch = line.match(/^COPY public\.(\w+)\s*\((.*?)\)\s+FROM stdin;/i);
        
        if (copyMatch) {
            currentTable = copyMatch[1].toLowerCase();
            columns = copyMatch[2].split(',').map(c => c.trim().replace(/"/g, ''));
            inCopy = true;
            buffer = [];
            continue;
        }
        
        if (inCopy) {
            if (line.trim() === '\\.' || line.trim() === '\\ .') {
                if (database[currentTable]) {
                    database[currentTable].push(...processRows(buffer, columns, currentTable));
                }
                inCopy = false;
                currentTable = null;
                continue;
            }
            if (!line.startsWith('--') && line.trim() !== '') {
                buffer.push(line);
            }
        }
    }
    return database;
}

function processRows(rows, cols, tableName) {
    return rows.map(row => {
        let values = row.split('\t').map(v => (v === '\\N' || v === 'NULL') ? null : v);
        let obj = {};
        cols.forEach((col, idx) => { obj[col] = values[idx]; });
        
        // Formatter Tipe Data & Sinkronisasi Variabel dari analisis Data Kasir.html
        if (tableName === 'c_trans') {
            obj.price = parseFloat(obj.price) || 0;
            obj.qty = parseFloat(obj.qty) || 0;
        } else if (tableName === 'c_tsale') {
            obj.jum = parseFloat(obj.jum) || 0;
            obj.cash = parseFloat(obj.cash) || 0;
            obj.card = parseFloat(obj.card) || 0;
        } else if (tableName === 'm_loader') {
            obj.price1 = parseFloat(obj.price1) || 0; // Harga Beli / Modal HPP
            obj.m_price = parseFloat(obj.m_price) || 0; // Harga Jual M-Price
        }
        return obj;
    });
}

// DASHBOARD LOGIC IMPLEMENTATION
function populateDashboardMetrics(data) {
    $('#statTrans').text(data.c_tsale.length);
    
    // Hitung Total Gross Margin Sales
    let grossRevenue = data.c_tsale.reduce((acc, curr) => acc + (curr.jum || 0), 0);
    $('#statSale').text(formatIDR(grossRevenue));
    $('#statMember').text(data.m_cust.length);
    $('#statProd').text(data.m_loader.length);

    // Grouping Tabel Summary Harian (Logika pembayaran dari analisis Data Kasir.html)
    const dailyMap = new Map();
    let cashSum = 0, qrisSum = 0, debitSum = 0;

    data.c_tsale.forEach(sale => {
        const date = sale.tgl_f || 'Unknown';
        if(!dailyMap.has(date)) {
            dailyMap.set(date, { count:0, total:0, cash:0, qris:0, debit:0 });
        }
        let node = dailyMap.get(date);
        node.count++;
        node.total += sale.jum;

        let method = 'cash';
        if (sale.j_card) {
            let jc = sale.j_card.toUpperCase();
            if (jc.includes('QRIS')) method = 'qris';
            else if (jc.includes('DEBIT') || jc.includes('CREDIT')) method = 'debit';
        } else if (sale.card > 0) {
            method = 'debit';
        }

        if(method === 'cash') { node.cash += sale.jum; cashSum += sale.jum; }
        else if(method === 'qris') { node.qris += sale.jum; qrisSum += sale.jum; }
        else { node.debit += sale.jum; debitSum += sale.jum; }
    });

    // Append ke UI Tabel Dashboard
    const tbody = $('#summaryBody').empty();
    dailyMap.forEach((v, k) => {
        tbody.append(`<tr>
            <td>${k}</td>
            <td>${v.count}</td>
            <td class="fw-semibold">${formatIDR(v.total)}</td>
            <td>${formatIDR(v.cash)}</td>
            <td>${formatIDR(v.qris)}</td>
            <td>${formatIDR(v.debit)}</td>
        </tr>`);
    });

    // Render Pie Chart
    if (paymentChartInstance) paymentChartInstance.destroy();
    const ctx = document.getElementById('paymentChart').getContext('2d');
    paymentChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: ['Cash', 'QRIS', 'Debit/Credit'],
            datasets: [{ data: [cashSum, qrisSum, debitSum], backgroundColor: ['#198754', '#0dcaf0', '#ffc107'] }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

// LABA RUGI (P&L) FINANCIAL LOGIC - GABUNGAN LOGIKA MASTER PRODUK
function calculateAndRenderPnL(data) {
    // 1. Mengambil Nilai Penjualan Bersih (Net Sales) langsung dari c_tsale (Total Jual)
    let grossSales = data.c_tsale.reduce((acc, curr) => acc + (curr.jum || 0), 0);
    let discount = 0; // Potongan/Diskon penjualan awal
    let netSales = grossSales - discount;

    // 2. Pemetaan Kode Master Produk (m_loader) untuk Menghitung HPP Secara Akurat
    const productCostMap = new Map();
    const productTaxMap = new Map();

    data.m_loader.forEach(p => {
        productCostMap.set(p.plu, parseFloat(p.price1) || 0); // price1 = Harga Beli / Modal
        productTaxMap.set(p.plu, p.ppn);                      // ppn status (1 = Kena Pajak)
    });

    let totalCogs = 0;        // Total Harga Pokok Penjualan
    let taxAllocation = 0;    // Alokasi Pajak (PPN)

    // 3. Iterasi Detail Item Terjual (c_trans) untuk Kalkulasi HPP dan PPN Riil
    data.c_trans.forEach(item => {
        let qty = parseFloat(item.qty) || 0;
        let priceJual = parseFloat(item.price) || 0;
        
        // Cari harga modal (price1) berdasarkan PLU produk di master data
        let hppPerItem = productCostMap.get(item.plu) || 0;
        
        // Antisipasi Fallback: Jika di master m_loader harga modal kosong atau bernilai 0,
        // Gunakan estimasi aman (Rule Dagang: HPP bernilai 70% dari harga jual item)
        if (hppPerItem === 0) {
            hppPerItem = priceJual * 0.7; 
        }

        // Akumulasi COGS/HPP: Modal per item * jumlah quantity terjual
        totalCogs += (hppPerItem * qty);

        // Perhitungan PPN berbasis field 'ppn' dari master data (1 = Ya, Kena Pajak 11%)
        let statusPpn = productTaxMap.get(item.plu);
        if (statusPpn == "1" || item.ppn == "1") {
            taxAllocation += (priceJual * qty * 0.11); 
        }
    });

    // 4. Kalkulasi Akhir Margin Keuangan
    let grossProfit = netSales - totalCogs;
    let netProfit = grossProfit - taxAllocation;

    // Mengambil rentang tanggal laporan dari c_tsale secara otomatis
    let dates = data.c_tsale.map(s => s.tgl_f).filter(Boolean).sort();
    let periodStr = dates.length ? `${dates[0]} s/d ${dates[dates.length - 1]}` : '-';

    // 5. Inject / Tampilkan Hasil ke Struktur Tabel P&L ERP yang Sudah Ada
    $('#pnlPeriod').text(`Periode: ${periodStr}`);
    $('#pnlGrossSales').text(formatIDR(grossSales));
    $('#pnlDiscount').text(`-${formatIDR(discount)}`);
    $('#pnlNetSales').text(formatIDR(netSales));
    
    $('#pnlCogs').text(`-${formatIDR(totalCogs)}`);
    $('#pnlTotalCogs').text(`-${formatIDR(totalCogs)}`);
    
    $('#pnlGrossProfit').text(formatIDR(grossProfit));
    $('#pnlTax').text(formatIDR(taxAllocation));
    $('#pnlNetProfit').text(formatIDR(netProfit));
}

// EXPORT TO EXCEL COMPONENT (SheetJS)
function exportAllToExcel() {
    if (!globalData) return;
    const wb = XLSX.utils.book_new();
    
    // Append Raw Sheets Data (Sesuai dengan format penulisan Excel ekspor)
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(globalData.c_tsale), "Header_Penjualan");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(globalData.c_trans), "Detail_Transaksi");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(globalData.m_loader), "Master_Produk");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(globalData.m_cust), "Member");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(globalData.cek_eod), "EOD_Log");
    
    // Trigger Save File
    XLSX.writeFile(wb, `ERP_AmandaMart_Report_${new Date().toISOString().slice(0,10)}.xlsx`);
}

$('#exportAllBtn').on('click', exportAllToExcel);
