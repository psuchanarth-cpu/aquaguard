const SPREADSHEET_ID = '1rTObZuGVmmVFPsOuNxrqFOBQItCQVawjizfvmYkBAcw';
const API_KEY = 'AIzaSyCnBiWANprtZ5enaHcUint0lrkcpQUF0tU';
const RED_THRESHOLD = 20;

const map = L.map('map').setView([7.9519, 98.3381], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const modal = document.getElementById("modal");
const modalInfo = document.getElementById("modal-info");
const span = document.getElementsByClassName("close")[0];
const searchBox = document.getElementById("search-box");
const searchSuggestions = document.getElementById("search-suggestions");

let markers = [];
let circles = [];

function getColor(status) {
    if (status === 'Green') return 'green';
    if (status === 'Yellow') return 'yellow';
    if (status === 'Red') return 'red';
    return 'blue';
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
    if (historyData.length < 2) return "Not enough data to predict.";
    const recent = historyData.slice(-5);
    const times = recent.map(d => new Date(d.timestamp).getTime());
    const levels = recent.map(d => d.distance);
    const timeDiff = times[times.length-1] - times[0];
    const levelDiff = levels[levels.length-1] - levels[0];
    if (timeDiff === 0 || levelDiff >= 0) return "✅ Water level is stable or falling.";
    const ratePerMs = levelDiff / timeDiff;
    const currentLevel = levels[levels.length-1];
    const distanceToRed = currentLevel - RED_THRESHOLD;
    if (distanceToRed <= 0) return "🔴 Already at danger level!";
    const minutesToRed = Math.round((distanceToRed / Math.abs(ratePerMs)) / 60000);
    if (minutesToRed < 60) return `⚠️ Predicted to reach danger level in ~${minutesToRed} minutes`;
    return `⚠️ Predicted to reach danger level in ~${Math.round(minutesToRed/60)} hours`;
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
                color: 'red', fillColor: '#f03', fillOpacity: 0.2, radius
            }).addTo(map));
        });
    }

    data.forEach(row => {
        const lat = parseFloat(row.latitude);
        const lng = parseFloat(row.longitude);
        const sensorId = row.sensor_id || row.H || '';

        const marker = L.circleMarker([lat, lng], {
            color: getColor(row.status), radius: 8, fillOpacity: 1
        }).addTo(map);

        marker.on('click', async function() {
            modalInfo.innerHTML = `
                <p><strong>Location:</strong> ${row.info || ''}</p>
                <p>Loading data...</p>`;
            modal.style.display = "flex";

            const historyData = await fetchHistory(sensorId);
            const prediction = getPrediction(historyData);

            const labels = historyData.map(d => {
                const date = new Date(d.timestamp);
                return `${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
            });
            const values = historyData.map(d => d.distance);

            modalInfo.innerHTML = `
                <p><strong>Location:</strong> ${row.info || ''}</p>
                ${row.image_url ? `<img src="${row.image_url}" style="width:100%;max-height:150px;object-fit:cover;border-radius:8px;" />` : ''}
                <p><strong>Water distance from shore:</strong> ${row.additional_info_1 || ''}</p>
                <p><strong>Status:</strong> ${row.additional_info_2 || ''}</p>
                <hr>
                <p><strong>📊 Prediction:</strong> ${prediction}</p>
                <hr>
                <p><strong>📈 24-Hour History</strong></p>
                <canvas id="waterChart" height="120"></canvas>
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
                                borderColor: 'blue',
                                backgroundColor: 'rgba(0,0,255,0.1)',
                                tension: 0.3,
                                fill: true
                            },
                            {
                                label: 'Danger Level',
                                data: Array(labels.length).fill(RED_THRESHOLD),
                                borderColor: 'red',
                                borderDash: [5,5],
                                pointRadius: 0
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: { title: { display: true, text: 'cm' } },
                            x: { title: { display: true, text: 'Time' } }
                        }
                    }
                });
            } else {
                document.getElementById('waterChart').outerHTML =
                    '<p style="color:gray;">No history data yet.</p>';
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
        container.innerHTML = '<p style="color:gray;">No alerts recorded yet.</p>';
        return;
    }

    container.innerHTML = alerts.map(row => {
        const time = new Date(row[0]).toLocaleString();
        return `<div style="padding:8px;border-bottom:1px solid #eee;">
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
setInterval(refreshApp, 10000); // refresh ทุก 10 วินาทีอัตโนมัติ

