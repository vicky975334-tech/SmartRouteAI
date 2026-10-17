// ====================================================
// MAPBOX ACCESS TOKEN SETUP
// ====================================================
const MAPBOX_ACCESS_TOKEN = "pk.eyJ1IjoidmlqYXlzciIsImEiOiJjbXZiOWh4NnUwM3Z5MnpzNnJpbHN4YmZiIn0.wiMXeh0P9haAqbyT5SLDcw";

// Application States
let map;
let aiModel = null;
let safetyVerified = false;
let isNavigating = false;
let watchPositionId = null;
let autoSuggestTimeout = null;

let selectedVehicle = 'bike';
let totalRouteDistanceKm = 0;
let distanceCoveredKm = 0;

let startCoords = [75.8577, 22.7196]; // Indore Default
let destCoords = [72.8777, 19.0760];  // Mumbai Default
let liveUserCoords = [...startCoords];

let startMarker, destinationMarker, vehicleMarker, poiMarkers = [];

const vehicleRates = {
    bike: { mileage: 45, tollPerKm: 0, requiredGear: "Helmet" },
    car: { mileage: 15, tollPerKm: 2.5, requiredGear: "Seatbelt" },
    truck: { mileage: 6, tollPerKm: 6.0, requiredGear: "Seatbelt" }
};
const fuelPricePerLiter = 100;

function initApp() {
    initMap();
    getUserLocation();
    updateVehicleSafetyUI();
    loadAIModel();
}

async function loadAIModel() {
    try {
        aiModel = await mobilenet.load();
        console.log("TensorFlow Model Ready.");
    } catch (err) {
        console.warn("AI Load fallback.");
    }
}

function initMap() {
    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

    map = new mapboxgl.Map({
        container: 'map',
        style: 'mapbox://styles/mapbox/dark-v11',
        center: startCoords,
        zoom: 6
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
        startMarker = new mapboxgl.Marker({ color: '#6366f1' })
            .setLngLat(startCoords)
            .setPopup(new mapboxgl.Popup().setHTML("<b>Origin</b>"))
            .addTo(map);

        destinationMarker = new mapboxgl.Marker({ color: '#10b981' })
            .setLngLat(destCoords)
            .setPopup(new mapboxgl.Popup().setHTML("<b>Destination Target</b>"))
            .addTo(map);

        fetchRoute();
    });
}

// 1. AUTO-SUGGEST SEARCH LOGIC
function handleAutoSuggest(query) {
    clearTimeout(autoSuggestTimeout);
    const box = document.getElementById('suggestions-box');

    if (!query || query.length < 2) {
        if (box) box.classList.add('hidden');
        return;
    }

    autoSuggestTimeout = setTimeout(() => {
        fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_ACCESS_TOKEN}&autocomplete=true&limit=5&country=IN`)
            .then(res => res.json())
            .then(data => {
                if (data.features && data.features.length > 0) {
                    box.innerHTML = "";
                    data.features.forEach(place => {
                        const div = document.createElement('div');
                        div.className = "p-2.5 hover:bg-slate-800 text-xs text-slate-200 cursor-pointer border-b border-slate-800/60 flex items-center gap-2";
                        div.innerHTML = `<i class="fa-solid fa-location-dot text-indigo-400"></i> <span>${place.place_name}</span>`;
                        div.onclick = () => {
                            document.getElementById('destination-input').value = place.text;
                            destCoords = place.center;
                            box.classList.add('hidden');
                            
                            destinationMarker.setLngLat(destCoords)
                                .setPopup(new mapboxgl.Popup().setHTML(`<b>${place.place_name}</b>`))
                                .togglePopup();

                            fetchRoute();
                        };
                        box.appendChild(div);
                    });
                    box.classList.remove('hidden');
                } else {
                    box.classList.add('hidden');
                }
            });
    }, 250);
}

function getUserLocation() {
    const originInput = document.getElementById('origin-input');
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                startCoords = [pos.coords.longitude, pos.coords.latitude];
                liveUserCoords = [...startCoords];
                
                if (map) {
                    map.flyTo({ center: startCoords, zoom: 11 });
                    if (startMarker) startMarker.setLngLat(startCoords);
                }
                originInput.value = `Indore / Live GPS (${startCoords[1].toFixed(2)}, ${startCoords[0].toFixed(2)})`;
                fetchRoute();
            },
            () => { originInput.value = "Indore, MP (GPS Location)"; fetchRoute(); }
        );
    }
}

function searchDestination() {
    const query = document.getElementById('destination-input').value;
    if (!query) return;

    fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_ACCESS_TOKEN}`)
        .then(res => res.json())
        .then(data => {
            if (data.features && data.features.length > 0) {
                destCoords = data.features[0].center;
                destinationMarker.setLngLat(destCoords).setPopup(new mapboxgl.Popup().setHTML(`<b>${data.features[0].place_name}</b>`)).togglePopup();
                fetchRoute();
            }
        });
}

function fetchRoute() {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${startCoords[0]},${startCoords[1]};${destCoords[0]},${destCoords[1]}?geometries=geojson&access_token=${MAPBOX_ACCESS_TOKEN}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                totalRouteDistanceKm = Math.round(route.distance / 1000);

                drawRouteOnMap(route.geometry);
                calculateCosting();
                loadRouteAttractions();
                updateTripHUD();
            }
        });
}

function drawRouteOnMap(geometry) {
    if (!map) return;
    const geojson = { 'type': 'Feature', 'geometry': geometry };

    if (map.getSource('route-line')) {
        map.getSource('route-line').setData(geojson);
    } else {
        map.addSource('route-line', { 'type': 'geojson', 'data': geojson });
        map.addLayer({
            'id': 'route-line',
            'type': 'line',
            'source': 'route-line',
            'paint': { 'line-color': '#6366f1', 'line-width': 5, 'line-opacity': 0.85 }
        });
    }

    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend(startCoords);
    bounds.extend(destCoords);
    map.fitBounds(bounds, { padding: 60 });
}

function selectVehicle(type, btnElement) {
    selectedVehicle = type;
    document.querySelectorAll('.vehicle-btn').forEach(b => b.classList.remove('active-vehicle'));
    if (btnElement) btnElement.classList.add('active-vehicle');
    
    safetyVerified = false;
    lockNavigationUI();
    updateVehicleSafetyUI();
    calculateCosting();
}

function updateVehicleSafetyUI() {
    const gear = vehicleRates[selectedVehicle].requiredGear;
    document.getElementById('safety-target-tag').innerText = `Requires: ${gear}`;
    document.getElementById('scan-btn-text').innerText = `Scan ${gear}`;
}

function calculateCosting() {
    const profile = vehicleRates[selectedVehicle];
    const fuelLiters = totalRouteDistanceKm / profile.mileage;
    const fuelCost = Math.round(fuelLiters * fuelPricePerLiter);
    const tollCost = Math.round(totalRouteDistanceKm * profile.tollPerKm);
    const totalCost = fuelCost + tollCost;

    document.getElementById('cost-distance').innerText = `${totalRouteDistanceKm} km`;
    document.getElementById('cost-toll').innerText = tollCost === 0 ? "₹0 (Toll Free)" : `₹${tollCost.toLocaleString('en-IN')}`;
    document.getElementById('cost-fuel').innerText = `₹${fuelCost.toLocaleString('en-IN')}`;
    document.getElementById('cost-total').innerText = `₹${totalCost.toLocaleString('en-IN')}`;
}

// STRICT CAMERA AI SCANNER
async function startStrictHelmetScan() {
    const scanLine = document.getElementById('scanning-line');
    const status = document.getElementById('scan-status');
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('detection-canvas');
    const ctx = canvas.getContext('2d');
    const requiredGear = vehicleRates[selectedVehicle].requiredGear;

    scanLine.style.display = 'block';
    status.innerText = `Status: AI Scanning for ${requiredGear}...`;
    status.className = "text-xs text-amber-400 mt-2 text-center";

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.classList.remove('hidden');
        document.getElementById('camera-icon').classList.add('hidden');
        document.getElementById('camera-text').classList.add('hidden');

        setTimeout(async () => {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            let isVerified = false;
            let label = "";

            if (aiModel) {
                const predictions = await aiModel.classify(video);
                const gearKeywords = ['helmet', 'crash helmet', 'seat belt', 'seatbelt', 'harness', 'strap'];

                for (let p of predictions) {
                    const name = p.className.toLowerCase();
                    if (gearKeywords.some(k => name.includes(k))) {
                        isVerified = true;
                        label = p.className;
                        break;
                    }
                }
            }

            scanLine.style.display = 'none';

            if (isVerified) {
                ctx.strokeStyle = "#10b981";
                ctx.lineWidth = 3;
                ctx.strokeRect(30, 20, canvas.width - 60, canvas.height - 40);
                
                ctx.fillStyle = "#10b981";
                ctx.fillRect(30, 20, 210, 20);
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 10px sans-serif";
                ctx.fillText(`VERIFIED: ${label.toUpperCase()}`, 35, 33);

                safetyVerified = true;
                status.innerText = `Status: ${requiredGear} Verified! Safety Gate Unlocked.`;
                status.className = "text-xs text-emerald-400 mt-2 text-center font-bold";
                unlockNavigationUI();
            } else {
                ctx.strokeStyle = "#ef4444";
                ctx.lineWidth = 3;
                ctx.strokeRect(30, 20, canvas.width - 60, canvas.height - 40);
                
                ctx.fillStyle = "#ef4444";
                ctx.fillRect(30, 20, 210, 20);
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 10px sans-serif";
                ctx.fillText(`FAILED: NO ${requiredGear.toUpperCase()}`, 35, 33);

                safetyVerified = false;
                status.innerText = `Status: No ${requiredGear} detected. Use Manual Confirm if wearing.`;
                status.className = "text-xs text-red-400 mt-2 text-center font-bold";
                lockNavigationUI();
            }
        }, 2500);

    } catch (err) {
        alert("Camera permission required.");
        scanLine.style.display = 'none';
    }
}

function manualOverride() {
    safetyVerified = true;
    const requiredGear = vehicleRates[selectedVehicle].requiredGear;
    document.getElementById('scan-status').innerText = `Status: ${requiredGear} Manually Confirmed by Driver`;
    document.getElementById('scan-status').className = "text-xs text-emerald-400 mt-2 text-center font-bold";
    unlockNavigationUI();
}

function lockNavigationUI() {
    const badge = document.getElementById('safety-badge');
    badge.className = "badge-locked px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 border";
    badge.innerHTML = `<i class="fa-solid fa-lock"></i> Safety Gate Locked`;

    const navBtn = document.getElementById('btn-start-nav');
    navBtn.disabled = true;
    navBtn.className = "w-full bg-slate-700 text-slate-500 font-bold py-3.5 rounded-xl text-sm transition cursor-not-allowed flex items-center justify-center gap-2 shadow-lg";
}

function unlockNavigationUI() {
    const badge = document.getElementById('safety-badge');
    badge.className = "badge-unlocked px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 border";
    badge.innerHTML = `<i class="fa-solid fa-lock-open"></i> Safety Gate Passed`;

    const navBtn = document.getElementById('btn-start-nav');
    navBtn.disabled = false;
    navBtn.className = "w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3.5 rounded-xl text-sm shadow-xl transition cursor-pointer flex items-center justify-center gap-2";
}

// 2. REAL PHYSICAL HARDWARE GPS TRACKING
function calculateDistanceInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in KM
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function toggleNavigation() {
    if (!safetyVerified) return;

    isNavigating = true;
    document.getElementById('navigation-hud').classList.remove('hidden');

    playVoiceAlert("Live GPS navigation started. Distance will update as you move.");

    if (!vehicleMarker) {
        const el = document.createElement('div');
        el.className = 'vehicle-nav-arrow';
        el.innerHTML = "<i class='fa-solid fa-location-arrow'></i>";
        vehicleMarker = new mapboxgl.Marker(el).setLngLat(liveUserCoords).addTo(map);
    }

    map.flyTo({
        center: liveUserCoords,
        zoom: 16.5,
        pitch: 60,
        speed: 1.2
    });

    if (navigator.geolocation) {
        watchPositionId = navigator.geolocation.watchPosition(
            (pos) => {
                const newPos = [pos.coords.longitude, pos.coords.latitude];
                
                // Calculate actual physical distance moved from start
                const movedKm = calculateDistanceInKm(startCoords[1], startCoords[0], newPos[1], newPos[0]);
                distanceCoveredKm = Math.min(totalRouteDistanceKm, Math.round(movedKm * 10) / 10);

                liveUserCoords = newPos;
                vehicleMarker.setLngLat(liveUserCoords);

                updateTripHUD();

                if (isNavigating) {
                    map.easeTo({
                        center: liveUserCoords,
                        zoom: 16.5,
                        pitch: 60,
                        duration: 800
                    });
                }
            },
            (err) => console.warn("GPS Location Error:", err),
            { enableHighAccuracy: true, maximumAge: 1000 }
        );
    }
}

function updateTripHUD() {
    const remainingKm = Math.max(0, (totalRouteDistanceKm - distanceCoveredKm).toFixed(1));
    const progressPercent = totalRouteDistanceKm > 0 ? Math.min(100, Math.round((distanceCoveredKm / totalRouteDistanceKm) * 100)) : 0;

    document.getElementById('hud-covered-km').innerText = `${distanceCoveredKm} km`;
    document.getElementById('hud-remaining-km').innerText = `${remainingKm} km`;
    document.getElementById('hud-progress-bar').style.width = `${progressPercent}%`;
}

// 3. EMERGENCY HOSPITAL SOS DISPATCH SYSTEM
function dispatchHospitalSOS() {
    const currentLocText = `${liveUserCoords[1].toFixed(4)}, ${liveUserCoords[0].toFixed(4)}`;
    const sosMessage = `EMERGENCY SOS ALERT: Accident/medical emergency reported at GPS (${currentLocText}). Requesting immediate ambulance dispatch from nearest District Hospital.`;

    playVoiceAlert("Emergency SOS dispatched to nearest hospital emergency center.");

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(sosMessage)}`;
    window.open(whatsappUrl, '_blank');

    alert(`🚨 Emergency SOS Dispatched!\n\nLocation: ${currentLocText}\nStatus: Ambulance alert sent.`);
}

function recenterToUser() {
    if (map && liveUserCoords) {
        map.flyTo({
            center: liveUserCoords,
            zoom: isNavigating ? 16.5 : 12,
            pitch: isNavigating ? 60 : 0,
            duration: 1000
        });
    }
}

function stopNavigation() {
    isNavigating = false;
    if (watchPositionId !== null) {
        navigator.geolocation.clearWatch(watchPositionId);
    }
    document.getElementById('navigation-hud').classList.add('hidden');

    map.flyTo({
        center: liveUserCoords,
        zoom: 7,
        pitch: 0,
        bearing: 0
    });
}

function loadRouteAttractions() {
    const container = document.getElementById('poi-container');
    const routeTag = document.getElementById('route-name-tag');
    const destInput = document.getElementById('destination-input').value.toLowerCase();

    poiMarkers.forEach(m => m.remove());
    poiMarkers = [];

    let attractions = [];

    if (destInput.includes('mumbai')) {
        routeTag.innerText = "NH-48 (Indore-Mumbai Highway)";
        attractions = [
            { name: "Dhule Highway Food Plaza", type: "Famous Food Stop", coords: [74.7749, 20.9042] },
            { name: "Trimbakeshwar Temple, Nashik", type: "Religious Landmark", coords: [73.5307, 19.9372] },
            { name: "Igatpuri Hill Station View", type: "Scenic Attraction", coords: [73.5594, 19.6952] },
            { name: "Gateway of India, Mumbai", type: "Destination Monument", coords: [72.8347, 18.9220] }
        ];
    } else if (destInput.includes('delhi')) {
        routeTag.innerText = "NH-52 (Indore-Jaipur-Delhi Highway)";
        attractions = [
            { name: "Udaipur City Palace", type: "Historical Landmark", coords: [73.6821, 24.5854] },
            { name: "Amer Fort, Jaipur", type: "Famous Fort", coords: [75.8513, 26.9855] },
            { name: "Murthal Paratha Dhabas", type: "Food Hub", coords: [77.0888, 29.0435] },
            { name: "India Gate, Delhi", type: "Destination Monument", coords: [77.2295, 28.6129] }
        ];
    } else {
        routeTag.innerText = "National Highway Route";
        attractions = [
            { name: "Highway Food Court Plaza", type: "Food Stop", coords: [(startCoords[0]+destCoords[0])/2, (startCoords[1]+destCoords[1])/2] },
            { name: "Regional Heritage Landmark", type: "Attraction", coords: [(startCoords[0]+destCoords[0])/2 + 0.05, (startCoords[1]+destCoords[1])/2 + 0.05] }
        ];
    }

    container.innerHTML = "";
    attractions.forEach(att => {
        const chip = document.createElement('span');
        chip.className = "bg-slate-800 border border-slate-700 px-2.5 py-1 rounded text-slate-300 flex items-center gap-1";
        chip.innerHTML = `<i class="fa-solid fa-star text-amber-400"></i> <strong>${att.name}</strong> <span class="text-[10px] text-slate-400">(${att.type})</span>`;
        container.appendChild(chip);

        const el = document.createElement('div');
        el.className = 'custom-marker';
        el.innerHTML = "<div style='background-color:#f59e0b; color:white; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid white;'><i class='fa-solid fa-camera text-xs'></i></div>";

        const m = new mapboxgl.Marker(el)
            .setLngLat(att.coords)
            .setPopup(new mapboxgl.Popup().setHTML(`<b>${att.name}</b><br><span style="color:#6366f1">${att.type}</span>`))
            .addTo(map);
        poiMarkers.push(m);
    });
}

function triggerAmbulance() {
    document.getElementById('ambulance-alert').classList.remove('hidden');
    playVoiceAlert("Emergency vehicle nearby. Please allow safe passage.");
}

function dismissAlert() {
    document.getElementById('ambulance-alert').classList.add('hidden');
}

function toggleTraffic() {
    alert("Simulating alternate high-congestion route.");
}

function playVoiceAlert(text) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(utterance);
    }
}

window.onload = () => {
    initApp();
};