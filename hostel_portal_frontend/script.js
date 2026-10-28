
const loginForm = document.getElementById("loginForm");
const captchaText = document.getElementById("captchaText");
const captchaInput = document.getElementById("captchaInput");
const refreshCaptcha = document.getElementById("refreshCaptcha");
const message = document.getElementById("message");
const rememberMe = document.getElementById("rememberMe");
const capIdInput = document.getElementById("capId");

// DEMO DATA ONLY.
// Replace this with backend/database verification for real students.
const demoStudents = [
    { capId: "CAP1001", stateRank: 120, name: "Student One" },
    { capId: "CAP1002", stateRank: 250, name: "Student Two" }
];

function generateCaptcha() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let captcha = "";

    for (let i = 0; i < 5; i++) {
        captcha += characters[
            Math.floor(Math.random() * characters.length)
        ];
    }

    captchaText.textContent = captcha;
    captchaInput.value = "";
}

refreshCaptcha.addEventListener("click", generateCaptcha);

loginForm.addEventListener("submit", function (event) {
    event.preventDefault();

    const capId = capIdInput.value.trim().toUpperCase();
    const stateRank = Number(
        document.getElementById("stateRank").value
    );
    const enteredCaptcha = captchaInput.value.trim().toUpperCase();

    // Check CAPTCHA
    if (enteredCaptcha !== captchaText.textContent) {
        message.textContent = "Incorrect CAPTCHA. Please try again.";
        message.style.color = "red";
        generateCaptcha();
        return;
    }

    // Find matching demo student
    const student = demoStudents.find(function (item) {
        return item.capId === capId &&
               item.stateRank === stateRank;
    });

    if (!student) {
        message.textContent =
            "CAP ID or State Rank is incorrect.";
        message.style.color = "red";
        generateCaptcha();
        return;
    }

    // Remember only the CAP ID, not a password or sensitive data
    if (rememberMe.checked) {
        localStorage.setItem("rememberedCapId", capId);
    } else {
        localStorage.removeItem("rememberedCapId");
    }

    // Store demo login state for the dashboard
    sessionStorage.setItem("studentName", student.name);
    sessionStorage.setItem("studentCapId", student.capId);
    sessionStorage.setItem("studentStateRank", student.stateRank);

    message.style.color = "green";
    message.textContent = "Login successful! Opening dashboard...";

    window.location.href = "dashboard.html";
});

// Restore remembered CAP ID
const savedCapId = localStorage.getItem("rememberedCapId");

if (savedCapId) {
    capIdInput.value = savedCapId;
    rememberMe.checked = true;
}

// Show the first CAPTCHA
generateCaptcha();
