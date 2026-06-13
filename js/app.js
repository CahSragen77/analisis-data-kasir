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
// LABA RUGI (P&L) FINANCIAL LOGIC - INTEGRATED VERSION
function calculateAndRenderPnL(data) {
    // 1. Ambil Total Pendapatan Kotor (Gross Sales) dari c_tsale
    let grossSales = data.c_tsale.reduce((acc, curr) => acc + (curr.jum || 0), 0);
    let discount = 0; // Set 0 atau sesuaikan jika ada kolom diskon di database Anda
    let netSales = grossSales - discount;

    // =========================================================================
    // INTEGRASI LOGIKA BARU: Hitung COGS (HPP) berdasarkan m_loader & c_trans
    // =========================================================================
    
    // Buat Map Master Produk dari m_loader untuk pencarian cepat O(1) berdasarkan PLU
    const productCostMap = new Map();
    data.m_loader.forEach(p => {
        // price1 = Harga Beli (HPP), m_price = Harga Jual Master
        productCostMap.set(p.plu, {
            hargaBeli: parseFloat(p.price1) || 0,
            hargaJualMaster: parseFloat(p.m_price) || 0
        });
    });

    let totalCogs = 0;
    let taxAllocation = 0;

    // Iterasi setiap item yang benar-benar terjual di c_trans
    data.c_trans.forEach(item => {
        let qty = parseFloat(item.qty) || 0;
        let productInfo = productCostMap.get(item.plu);
        
        let hppPerItem = 0;

        if (productInfo) {
            hppPerItem = productInfo.hargaBeli;
        }
        
        // Failsafe / Antisipasi: Jika produk tidak ditemukan di master atau harga beli bernilai 0,
        // gunakan estimasi rasio profit margin standar (misal: HPP adalah 70% dari harga jual di transaksi)
        if (hppPerItem === 0) {
            let hargaJualAktual = parseFloat(item.price) || 0;
            hppPerItem = hargaJualAktual * 0.7; 
        }

        // Akumulasi Total COGS (HPP = Harga Beli x Qty Terjual)
        totalCogs += (hppPerItem * qty);

        // Hitung Alokasi Pajak (PPN) jika produk tersebut bertanda PPN (ppn == 1)
        if (item.ppn == "1") {
            let hargaJualAktual = parseFloat(item.price) || 0;
            taxAllocation += (hargaJualAktual * qty * 0.11); // PPN 11%
        }
    });

    // 3. Kalkulasi Profit Margins
    let grossProfit = netSales - totalCogs;
    let netProfit = grossProfit - taxAllocation;

    // 4. Ambil Rentang Tanggal untuk Periode Laporan
    let dates = data.c_tsale.map(s => s.tgl_f).filter(Boolean).sort();
    let periodStr = dates.length ? `${dates[0]} s/d ${dates[dates.length - 1]}` : '-';

    // =========================================================================
    // RENDER KE UI (Tetap mempertahankan ID elemen HTML dari template sebelumnya)
    // =========================================================================
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
