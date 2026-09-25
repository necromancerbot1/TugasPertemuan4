// ==============================================
// 1. INISIALISASI WIDGET GOOGLE TRANSLATE
// ==============================================
function googleTranslateElementInit() {
    new google.translate.TranslateElement({
        pageLanguage: 'id',
        includedLanguages: 'id,en,ja,de,ko,zh-CN,ar,es,fr,ru', 
        layout: google.translate.TranslateElement.InlineLayout.SIMPLE
    }, 'google_translate_element');
}

// ==============================================
// 2. LOGIKA MENU HAMBURGER & AUTO-CLOSE
// ==============================================
const hamburger = document.getElementById('hamburger');
const menu = document.getElementById('menu');
const menuLinks = document.querySelectorAll('.menu a');

hamburger.addEventListener('click', () => {
    menu.classList.toggle('aktif');
});

menuLinks.forEach(link => {
    link.addEventListener('click', () => {
        menu.classList.remove('aktif');
    });
});

// ==============================================
// 3. LOGIKA ANIMASI SCROLL REVEAL & PROGRESS BAR
// ==============================================
const reveals = document.querySelectorAll('.reveal');

const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('muncul'); 
            
            const progressBars = entry.target.querySelectorAll('.bar-fill');
            if (progressBars.length > 0) {
                progressBars.forEach(bar => {
                    const targetWidth = bar.getAttribute('data-width');
                    bar.style.width = targetWidth;
                });
            }
            
            scrollObserver.unobserve(entry.target);
        }
    });
}, {
    threshold: 0.15 
});

reveals.forEach(reveal => {
    scrollObserver.observe(reveal);
});