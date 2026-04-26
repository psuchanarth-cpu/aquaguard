const SPREADSHEET_ID = '1rTObZuGVmmVFPsOuNxrqFOBQItCQVawjizfvmYkBAcw';
const API_KEY = 'AIzaSyCnBiWANprtZ5enaHcUint0lrkcpQUF0tU';
const RED_THRESHOLD = 20;

const map = L.map('map').setView([7.9519, 98.3381], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
}).addTo(map);

const modal = document.getElementById("modal");
const modalInfo = document.getElementById("modal-info");
const span = document.getElementsByClassName("close")[0];
const searchBox = document.getElementById("search-box");
const searchSuggestions = document.getElementById("search-suggestions");

let markers = [];
let circles = [];

function getColor(status) {
    if (status === 'Green') return '#00cc66';
    if (status === 'Yellow') return '#ffaa00';
    if (status === 'Red') return '#ff4444';
    return '#4fc3f7';
}

function calculateCenter(points) {
    const sum = points.reduce((acc, p) => [acc[0]+p[0], acc[1]+p[1]], [0,0]);
    return [sum[0]/points.length, sum[1]/points.length];
}

function calculateDistance(p1, p2) {
    const R = 6371;
    const dLat = (p2[0]-p1[0]) * Math.PI/180;
    const dLng = (p2[1]-p1[1]) * Math.PI/180;
    const a = 0.5 - Math.cos(dLat)/2 +
        Math.cos(p1[0]*Math.PI/180) * Math.cos(p2[0]*Math.PI/180) *
        (1-Math.cos(dLng))/2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function calculateRadius(center, points) {
    return Math.max(...points.map(p => calculateDistance(center, p)));
}

async function fetchHistory(sensorId) {
    const res = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'History!A:C',
    });
    const data = res.result.values;
    if (!data || data.length < 2) return [];
    const oneDayAgo = Date.now() - 86400000;
    return data.slice(1)
        .filter(row => row[1] == sensorId && new Date(row[0]).getTime() > oneDayAgo)
        .filter(row => parseFloat(row[2]) < 400)
        .map(row => ({ timestamp: row[0], distance: parseFloat(row[2]) }));
}

async function fetchAlerts() {
    const res = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Alerts!A:C',
    });
    const data = res.result.values;
    if (!data || data.length < 2) return [];
    return data.slice(1).slice(-5).reverse();
}

function getPrediction(historyData) {
    if (historyData.length < 5) return "Not enough data to predict.";
    const recent = historyData.slice(-10);
    const times = recent.map(d => new Date(d.timestamp).getTime());
    const levels = recent.map(d => d.distance);
    const n = recent.length;
    const sumX = times.reduce((a, b) => a + b, 0);
    const sumY = levels.reduce((a, b) => a + b, 0);
    const sumXY = times.reduce((sum, t, i) => sum + t * levels[i], 0);
    const sumX2 = times.reduce((sum, t) => sum + t * t, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    if (slope >= 0) return "✅ Water level is stable or falling.";
    const currentTime = times[times.length - 1];
    const currentLevel = levels[levels.length - 1];
    if (currentLevel <= RED_THRESHOLD) return "🔴 Already at danger level!";
    const timeToRed = (RED_THRESHOLD - intercept - slope * currentTime) / slope;
    const minutesToRed = Math.round((timeToRed - currentTime) / 60000);
    if (minutesToRed <= 0) return "🔴 Danger level reached imminently!";
    if (minutesToRed < 60) return `⚠️ Predicted to reach danger level in ~${minutesToRed} minutes`;
    return `⚠️ Predicted to reach danger level in ~${Math.round(minutesToRed / 60)} hours`;
}

function createMarkers(data) {
    const redPoints = [];
    markers.forEach(m => map.removeLayer(m.marker));
    circles.forEach(c => map.removeLayer(c));
    markers = [];
    circles = [];

    data.forEach(row => {
        if (row.status === 'Red') {
            redPoints.push([parseFloat(row.latitude), parseFloat(row.longitude)]);
        }
    });

    if (redPoints.length > 0) {
        let groups = [];
        redPoints.forEach(point => {
            let added = false;
            groups = groups.map(group => {
                if (calculateDistance(calculateCenter(group), point) <= 50) {
                    group.push(point); added = true;
                }
                return group;
            });
            if (!added) groups.push([point]);
        });

        groups.forEach(group => {
            const center = calculateCenter(group);
            const radius = calculateRadius(center, group) * 1000;
            circles.push(L.circle(center, {
                color: '#ff4444', fillColor: '#ff4444', fillOpacity: 0.15, radius
            }).addTo(map));
        });
    }

    data.forEach(row => {
        const lat = parseFloat(row.latitude);
        const lng = parseFloat(row.longitude);
        const sensorId = row.sensor_id || '';

        const marker = L.circleMarker([lat, lng], {
            color: getColor(row.status),
            fillColor: getColor(row.status),
            radius: 10,
            fillOpacity: 1,
            weight: 2
        }).addTo(map);

        marker.on('click', async function() {
            modalInfo.innerHTML = `
                <div style="padding:20px;color:#fff;">
                    <p><strong>${row.info || ''}</strong></p>
                    <p style="color:#aaa;">Loading data...</p>
                </div>`;
            modal.style.display = "flex";

            const historyData = await fetchHistory(sensorId);
            const prediction = getPrediction(historyData);
            const currentDistance = row['distance'] || '--';

            const statusColor = row.status === 'Red' ? '#ff4444' : row.status === 'Yellow' ? '#ffaa00' : '#00cc66';
            const statusLabel = row.status === 'Red' ? 'DANGER' : row.status === 'Yellow' ? 'CAUTION' : 'CLEAR';

            const labels = historyData.map(d => {
                const date = new Date(d.timestamp);
                return `${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
            });
            const values = historyData.map(d => d.distance);

            modalInfo.innerHTML = `
<div style="background:#0d1117;color:#fff;padding:20px;font-family:Arial,sans-serif;">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
            <h2 style="margin:0;font-size:20px;color:#fff;">${row.info || ''}</h2>
            <p style="margin:4px 0 0;color:#aaa;font-size:13px;">📍 Phuket, Thailand</p>
        </div>
        <div style="background:${statusColor}22;border:1px solid ${statusColor};border-radius:20px;padding:6px 14px;color:${statusColor};font-weight:bold;font-size:13px;">
            ● ${statusLabel}
        </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div style="background:#1a2035;border-radius:12px;padding:14px;">
            <div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Water Distance</div>
            <div style="font-size:32px;font-weight:bold;margin-top:4px;color:#4fc3f7;">${currentDistance} <span style="font-size:14px;color:#aaa;">cm</span></div>
        </div>
        <div style="background:#1a2035;border-radius:12px;padding:14px;">
            <div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Danger Threshold</div>
            <div style="font-size:32px;font-weight:bold;margin-top:4px;color:#ff4444;">${RED_THRESHOLD} <span style="font-size:14px;color:#aaa;">cm</span></div>
        </div>
    </div>

    <div style="background:#1a1a2e;border:1px solid #ff444466;border-radius:12px;padding:14px;margin-bottom:16px;">
        <div style="font-size:13px;color:#ffaa00;font-weight:bold;">⚠️ AI Prediction: ${prediction.replace('⚠️','').replace('✅','').replace('🔴','').trim()}</div>
    </div>

    <div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">📈 24-Hour History</div>
    <div style="background:#1a2035;border-radius:12px;padding:12px;">
        <canvas id="waterChart" height="120"></canvas>
    </div>

</div>
`;

            if (historyData.length > 0) {
                const ctx = document.getElementById('waterChart').getContext('2d');
                new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels,
                        datasets: [
                            {
                                label: 'Water Distance (cm)',
                                data: values,
                                borderColor: '#4fc3f7',
                                backgroundColor: 'rgba(79,195,247,0.1)',
                                tension: 0.4,
                                fill: true,
                                pointRadius: 2
                            },
                            {
                                label: 'Danger Level',
                                data: Array(labels.length).fill(RED_THRESHOLD),
                                borderColor: '#ff4444',
                                borderDash: [5,5],
                                pointRadius: 0,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: { labels: { color: '#aaa' } }
                        },
                        scales: {
                            y: {
                                title: { display: true, text: 'cm', color: '#aaa' },
                                ticks: { color: '#aaa' },
                                grid: { color: '#2a3050' }
                            },
                            x: {
                                title: { display: true, text: 'Time', color: '#aaa' },
                                ticks: { color: '#aaa', maxTicksLimit: 6 },
                                grid: { color: '#2a3050' }
                            }
                        }
                    }
                });
            } else {
                document.getElementById('waterChart').outerHTML =
                    '<p style="color:#aaa;text-align:center;padding:20px;">No history data yet.</p>';
            }
        });

        marker.bringToFront();
        markers.push({ marker, info: row.info, position: [lat, lng] });
    });

    updateSearchSuggestions();
    loadAlertLog();
}

async function loadAlertLog() {
    const alerts = await fetchAlerts();
    const container = document.getElementById('alert-log');
    if (!container) return;

    if (alerts.length === 0) {
        container.innerHTML = '<p style="color:#aaa;font-size:13px;">No alerts recorded yet.</p>';
        return;
    }

    container.innerHTML = alerts.map(row => {
        const time = new Date(row[0]).toLocaleString();
        return `<div style="padding:8px 0;border-bottom:1px solid #1a2035;font-size:13px;color:#eee;">
            🔴 <strong>${time}</strong> — ${row[1]} reached danger level (${row[2]} cm)
        </div>`;
    }).join('');
}

function updateSearchSuggestions() {
    searchSuggestions.innerHTML = '';
    markers.forEach(({ info }) => {
        const option = document.createElement('option');
        option.value = info;
        searchSuggestions.appendChild(option);
    });
}

function initClient() {
    gapi.client.init({
        apiKey: API_KEY,
        discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    }).then(() => {
        return gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:J',
        });
    }).then(response => {
        const data = response.result.values;
        const headers = data[0];
        const rows = data.slice(1).map(row => {
            let obj = {};
            headers.forEach((h, i) => obj[h] = row[i] || '');
            return obj;
        });
        createMarkers(rows);
    });
}

gapi.load('client', initClient);

span.onclick = () => modal.style.display = "none";
window.onclick = e => { if (e.target == modal) modal.style.display = "none"; };

searchBox.addEventListener('change', function() {
    const found = markers.find(({ info }) =>
        info.toLowerCase() === searchBox.value.toLowerCase());
    if (found) map.setView(found.position, 15);
});

function refreshApp() { initClient(); }
setInterval(refreshApp, 10000);
