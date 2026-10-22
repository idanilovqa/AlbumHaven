const settlePaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const title=page=>page.getByRole('textbox',{name:'Album Top name',exact:true});


module.exports={settlePaint,title};
