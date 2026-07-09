// Decorative modal backdrop: a blurred tint layer plus a crystalline SVG scene
// shown only in dark mode; clicking it dismisses the dialog.
interface CrystalBackdropProps {
  onClick?: () => void
}

export default function CrystalBackdrop({ onClick }: CrystalBackdropProps) {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true" onClick={onClick}>
      <div className="absolute inset-0 bg-primary/10 backdrop-blur-sm dark:bg-surface/60" />
      <svg
        className="absolute inset-0 w-full h-full hidden dark:block"
        viewBox="0 0 1150 560"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <style>{`
          @keyframes crystal-flash { 0% { opacity: 0.09 } 100% { opacity: 0.24 } }
          .cf { opacity: 0.09 }
          .cf:nth-child(2n) { animation: crystal-flash 20s ease alternate infinite }
          .cf:nth-child(3n) { animation: crystal-flash 30s ease alternate infinite }
          .cf:nth-child(7n) { animation: crystal-flash 70s ease alternate infinite }
        `}</style>
        <polygon className="cf" fill="#AEAEAE" stroke="#B2B2B2" strokeMiterlimit={10} points="-0.5,0 162.167,162.667 -0.5,154.334" />
        <polygon className="cf" fill="#25B272" stroke="#B2B2B2" strokeMiterlimit={10} points="-0.5,154.334 100.333,280 162.167,162.667" />
        <polygon className="cf" fill="#1FA34F" stroke="#B2B2B2" strokeMiterlimit={10} points="100.333,279.833 -0.5,345.002 -0.5,154" />
        <polygon className="cf" fill="#70AC91" stroke="#B2B2B2" strokeMiterlimit={10} points="162.167,162.667 244.336,233.003 206.336,302.336 100.333,279.833" />
        <polygon className="cf" fill="#2C8C4A" stroke="#B2B2B2" strokeMiterlimit={10} points="100.333,279.833 133.003,413.668 -0.5,345.002" />
        <polygon className="cf" fill="#3CA569" stroke="#B2B2B2" strokeMiterlimit={10} points="-0.5,345.002 0,472.335 133.003,413.668" />
        <polygon className="cf" fill="#32B253" stroke="#B2B2B2" strokeMiterlimit={10} points="95.421,560.5 132.628,413.918 -0.5,472.335 -0.5,560.5" />
        <polygon className="cf" fill="#1A9A60" stroke="#B2B2B2" strokeMiterlimit={10} points="132.628,413.918 221.003,399.002 206.336,302.336 100.333,279.833" />
        <polygon className="cf" fill="#5BB28E" stroke="#B2B2B2" strokeMiterlimit={10} points="162.167,162.667 157.667,41.004 -0.5,0" />
        <polygon className="cf" fill="#2E9968" stroke="#B2B2B2" strokeMiterlimit={10} points="162.331,162.666 244.5,143.67 244.5,233" />
        <polygon className="cf" fill="#1E9A77" stroke="#B2B2B2" strokeMiterlimit={10} points="244.5,233 307.666,267.005 330.333,194.338" />
        <polygon className="cf" fill="#1DA272" stroke="#B2B2B2" strokeMiterlimit={10} points="244.5,143.67 330.333,194.338 244.5,233" />
        <polygon className="cf" fill="#439E74" stroke="#B2B2B2" strokeMiterlimit={10} points="162.331,162.666 157.667,41.004 230.333,0 244.5,143.67" />
        <polygon className="cf" fill="#2F9E70" stroke="#B2B2B2" strokeMiterlimit={10} points="230,0.5 -1,0.5 157.667,41.004" />
        <polygon className="cf" fill="#66A788" stroke="#B2B2B2" strokeMiterlimit={10} points="206.336,302.336 244.5,233 307.666,267.005 296.334,332.34" />
        <polygon className="cf" fill="#149A61" stroke="#B2B2B2" strokeMiterlimit={10} points="206.336,302.336 296.334,332.34 269.667,421.674 221.003,399.002" />
        <polygon className="cf" fill="#2DAE86" stroke="#B2B2B2" strokeMiterlimit={10} points="307.666,267.005 383.005,346.875 356.338,408.668 296.334,332.34" />
        <polygon className="cf" fill="#19906B" stroke="#B2B2B2" strokeMiterlimit={10} points="296.334,332.34 356.338,408.668 326.336,439.008 269.667,421.674" />
        <polygon className="cf" fill="#46B280" stroke="#B2B2B2" strokeMiterlimit={10} points="221.003,399.002 190.338,487.209 132.628,413.918" />
        <polygon className="cf" fill="#33A973" stroke="#B2B2B2" strokeMiterlimit={10} points="190.338,487.209 95.421,560.5 132.628,413.918" />
        <polygon className="cf" fill="#69B293" stroke="#B2B2B2" strokeMiterlimit={10} points="269.667,421.674 277,499.668 190.338,487.209 221.003,399.002" />
        <polygon className="cf" fill="#1E9E64" stroke="#B2B2B2" strokeMiterlimit={10} points="277,499.668 190.338,487.209 95.421,560.5 244.5,560" />
        <polygon className="cf" fill="#7AAE97" stroke="#B2B2B2" strokeMiterlimit={10} points="356.338,408.668 383.005,346.875 435.001,373" />
        <polygon className="cf" fill="#2C876D" stroke="#B2B2B2" strokeMiterlimit={10} points="356.338,408.668 352.337,464.334 326.336,439.008" />
        <polygon className="cf" fill="#74AE98" stroke="#B2B2B2" strokeMiterlimit={10} points="352.337,464.334 277,499.668 269.667,421.674 326.336,439.008" />
        <polygon className="cf" fill="#2E9970" stroke="#B2B2B2" strokeMiterlimit={10} points="352.337,464.334 398.337,499.668 244.5,560 277,499.668" />
        <polygon className="cf" fill="#25A05F" stroke="#B2B2B2" strokeMiterlimit={10} points="162.331,162.666 -0.5,154 -1,0.5" />
        <polygon className="cf" fill="#69B291" stroke="#B2B2B2" strokeMiterlimit={10} points="330.333,194.338 339.669,118.994 244.5,143.67" />
        <polygon className="cf" fill="#4BB283" stroke="#B2B2B2" strokeMiterlimit={10} points="339.669,118.994 230,0.5 244.5,143.67" />
        <polygon className="cf" fill="#24927D" stroke="#B2B2B2" strokeMiterlimit={10} points="339.669,118.994 230,0.5 408,0" />
        <polygon className="cf" fill="#249270" stroke="#B2B2B2" strokeMiterlimit={10} points="307.666,267.005 408,302.336 423,162.666 330.333,194.338" />
        <polygon className="cf" fill="#249277" stroke="#B2B2B2" strokeMiterlimit={10} points="307.666,267.005 383.005,346.875 408,302.336" />
        <polygon className="cf" fill="#249280" stroke="#B2B2B2" strokeMiterlimit={10} points="383.005,346.875 408,302.336 435.001,373" />
        <polygon className="cf" fill="#249277" stroke="#B2B2B2" strokeMiterlimit={10} points="398.337,499.668 435.001,373 356.338,408.668 352.337,464.334" />
        <polygon className="cf" fill="#249272" stroke="#B2B2B2" strokeMiterlimit={10} points="244.5,560.5 398.337,500.168 471,560.5" />
        <polygon className="cf" fill="#249277" stroke="#B2B2B2" strokeMiterlimit={10} points="408,0 339.669,118.994 423,162.666 461,81.583" />
        <polygon className="cf" fill="#87B2A5" stroke="#B2B2B2" strokeMiterlimit={10} points="339.669,118.994 330.333,194.338 423,162.666" />
        <polygon className="cf" fill="#429389" stroke="#B2B2B2" strokeMiterlimit={10} points="460.75,81.586 407.625,0.001 547.5,0.5 547.5,119" />
        <polygon className="cf" fill="#87B2AA" stroke="#B2B2B2" strokeMiterlimit={10} points="547.5,119 460.75,81.586 423,162.666" />
        <polygon className="cf" fill="#87B2A7" stroke="#B2B2B2" strokeMiterlimit={10} points="423,162.666 547.5,119 492,217.167" />
        <polygon className="cf" fill="#5D9A87" stroke="#B2B2B2" strokeMiterlimit={10} points="423,162.666 492,217.167 408,302.336" />
        <polygon className="cf" fill="#289583" stroke="#B2B2B2" strokeMiterlimit={10} points="408,302.336 513,337.837 507,399.002 435.001,373" />
        <polygon className="cf" fill="#5DB29A" stroke="#B2B2B2" strokeMiterlimit={10} points="398.337,500.168 435.001,373 507,399.002" />
        <polygon className="cf" fill="#4FA292" stroke="#B2B2B2" strokeMiterlimit={10} points="398.337,500.168 507,399.002 471,560.5" />
        <polygon className="cf" fill="#6FA595" stroke="#B2B2B2" strokeMiterlimit={10} points="408,302.336 492,217.167 513,337.837" />
        <polygon className="cf" fill="#659997" stroke="#B2B2B2" strokeMiterlimit={10} points="492,217.167 591,194.338 596,277.502 513,337.837" />
        <polygon className="cf" fill="#58A5A3" stroke="#B2B2B2" strokeMiterlimit={10} points="591,194.338 492,217.167 547.5,119" />
        <polygon className="cf" fill="#497A6D" stroke="#B2B2B2" strokeMiterlimit={10} points="507,399.002 572,346.75 596,277.502 513,337.837" />
        <polygon className="cf" fill="#8BB2B2" stroke="#B2B2B2" strokeMiterlimit={10} points="507,399.002 576,428 635,373 572,346.75" />
        <polygon className="cf" fill="#4A998E" stroke="#B2B2B2" strokeMiterlimit={10} points="471,560.5 507,399.002 576,428" />
        <polygon className="cf" fill="#5B9399" stroke="#B2B2B2" strokeMiterlimit={10} points="576,428 471,560.5 607,560.5" />
        <polygon className="cf" fill="#516C70" stroke="#B2B2B2" strokeMiterlimit={10} points="635,373 607,560.5 576,428" />
        <polygon className="cf" fill="#42938F" stroke="#B2B2B2" strokeMiterlimit={10} points="572,346.75 640,302.336 596,277.502" />
        <polygon className="cf" fill="#61A29C" stroke="#B2B2B2" strokeMiterlimit={10} points="635,373 640,302.336 572,346.75" />
        <polygon className="cf" fill="#578382" stroke="#B2B2B2" strokeMiterlimit={10} points="635,373 726,436.334 692,494.25 607,560.5" />
        <polygon className="cf" fill="#74979C" stroke="#B2B2B2" strokeMiterlimit={10} points="607,560.5 767,560.5 692,494.25" />
        <polygon className="cf" fill="#589389" stroke="#B2B2B2" strokeMiterlimit={10} points="547.5,119 547.5,1 652,0" />
        <polygon className="cf" fill="#7A9A9C" stroke="#B2B2B2" strokeMiterlimit={10} points="591,194.338 682,107 547.5,119" />
        <polygon className="cf" fill="#65858A" stroke="#B2B2B2" strokeMiterlimit={10} points="547.5,119 652,0 714,41.004 682,107" />
        <polygon className="cf" fill="#599497" stroke="#B2B2B2" strokeMiterlimit={10} points="682,107 753,137 772,94 714,41.004" />
        <polygon className="cf" fill="#8D9CA0" stroke="#B2B2B2" strokeMiterlimit={10} points="652,1.5 803,1.5 714,42.004" />
        <polygon className="cf" fill="#708792" stroke="#B2B2B2" strokeMiterlimit={10} points="772,94 803,0.5 714,41.004" />
        <polygon className="cf" fill="#568782" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,302 639.5,217 591,194.338 596,277.502" />
        <polygon className="cf" fill="#54858C" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,217 753,137 682,107 591,194.338" />
        <polygon className="cf" fill="#66878C" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,217 767,338.252 639.5,302" />
        <polygon className="cf" fill="#698C8E" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,302 635,373 726,436.334" />
        <polygon className="cf" fill="#638790" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,302 726,436.334 767,338.252" />
        <polygon className="cf" fill="#6E788A" stroke="#B2B2B2" strokeMiterlimit={10} points="726,436.334 960,560 767,560.5" />
        <polygon className="cf" fill="#49767A" stroke="#B2B2B2" strokeMiterlimit={10} points="726,436.334 692,494.25 767,560.5" />
        <polygon className="cf" fill="#5B90A2" stroke="#B2B2B2" strokeMiterlimit={10} points="753,137 729.5,242 639.5,217" />
        <polygon className="cf" fill="#4F747C" stroke="#B2B2B2" strokeMiterlimit={10} points="639.5,217 729.5,242 767,338.252" />
        <polygon className="cf" fill="#8E97B2" stroke="#B2B2B2" strokeMiterlimit={10} points="729.5,242 900,233 753,137" />
        <polygon className="cf" fill="#5F748E" stroke="#B2B2B2" strokeMiterlimit={10} points="767,338.252 729.5,242 900,233" />
        <polygon className="cf" fill="#7F7C8E" stroke="#B2B2B2" strokeMiterlimit={10} points="767,338.252 859,408.668 726,436.334" />
        <polygon className="cf" fill="#586773" stroke="#B2B2B2" strokeMiterlimit={10} points="767,338.252 859,408.668 900,233" />
        <polygon className="cf" fill="#6D697C" stroke="#B2B2B2" strokeMiterlimit={10} points="726,436.334 859,408.668 960,560" />
        <polygon className="cf" fill="#757B9A" stroke="#B2B2B2" strokeMiterlimit={10} points="772,94 879,118.994 900,233 753,137" />
        <polygon className="cf" fill="#746C90" stroke="#B2B2B2" strokeMiterlimit={10} points="900,233 932,181 937,255" />
        <polygon className="cf" fill="#696E8C" stroke="#B2B2B2" strokeMiterlimit={10} points="932,181.25 879,118.994 900,233" />
        <polygon className="cf" fill="#79809C" stroke="#B2B2B2" strokeMiterlimit={10} points="772,94 803,0.5 848,0.5 879,118.994" />
        <polygon className="cf" fill="#696880" stroke="#B2B2B2" strokeMiterlimit={10} points="848,0.5 919,0.5 879,118.994" />
        <polygon className="cf" fill="#766B90" stroke="#B2B2B2" strokeMiterlimit={10} points="879,118.994 919,0.5 959.5,114" />
        <polygon className="cf" fill="#6D6883" stroke="#B2B2B2" strokeMiterlimit={10} points="859,408.668 959.5,425.5 960,560" />
        <polygon className="cf" fill="#7E7699" stroke="#B2B2B2" strokeMiterlimit={10} points="859,408.668 900,233 937,255.218 959.5,425.5" />
        <polygon className="cf" fill="#736C93" stroke="#B2B2B2" strokeMiterlimit={10} points="919,0.5 1039.001,1.5 959.5,114" />
        <polygon className="cf" fill="#9785AA" stroke="#B2B2B2" strokeMiterlimit={10} points="879,118.994 932,181.25 959.5,114" />
        <polygon className="cf" fill="#755989" stroke="#B2B2B2" strokeMiterlimit={10} points="932,181.25 937,255.218 1062.997,233" />
        <polygon className="cf" fill="#796690" stroke="#B2B2B2" strokeMiterlimit={10} points="937,255.218 1062.997,233 959.5,425.5" />
        <polygon className="cf" fill="#6E5587" stroke="#B2B2B2" strokeMiterlimit={10} points="959.5,425.5 1062.997,394.333 1098.991,316.333 1062.997,233" />
        <polygon className="cf" fill="#715F83" stroke="#B2B2B2" strokeMiterlimit={10} points="959.003,425.666 1062.5,394.333 1062.5,470 997.498,481" />
        <polygon className="cf" fill="#716385" stroke="#B2B2B2" strokeMiterlimit={10} points="959.003,425.666 960,560 997.498,481" />
        <polygon className="cf" fill="#9485A7" stroke="#B2B2B2" strokeMiterlimit={10} points="960,560.5 997.498,481.25 1062.5,470.375 1150,560.5" />
        <polygon className="cf" fill="#705887" stroke="#B2B2B2" strokeMiterlimit={10} points="1062,470.207 1149.5,560.5 1149.5,474" />
        <polygon className="cf" fill="#66527C" stroke="#B2B2B2" strokeMiterlimit={10} points="1062,470.207 1062.5,394.333 1149.5,474" />
        <polygon className="cf" fill="#654A73" stroke="#B2B2B2" strokeMiterlimit={10} points="1062.5,394.333 1149.5,351.668 1149.5,474" />
        <polygon className="cf" fill="#9485A7" stroke="#B2B2B2" strokeMiterlimit={10} points="1098.991,316.333 1062.5,394.333 1149.5,351.668" />
        <polygon className="cf" fill="#66527C" stroke="#B2B2B2" strokeMiterlimit={10} points="1148.5,351.668 1097.991,316.333 1148.5,181" />
        <polygon className="cf" fill="#705D80" stroke="#B2B2B2" strokeMiterlimit={10} points="1098.991,316.333 1062.997,233 1149.5,181" />
        <polygon className="cf" fill="#7E6D92" stroke="#B2B2B2" strokeMiterlimit={10} points="932,181.25 959.5,114 1062.997,233" />
        <polygon className="cf" fill="#85779A" stroke="#B2B2B2" strokeMiterlimit={10} points="1039.001,1.5 959.5,114 1062.997,233" />
        <polygon className="cf" fill="#8C7B9C" stroke="#B2B2B2" strokeMiterlimit={10} points="1039.001,1.5 1062.997,233 1149.5,181" />
        <polygon className="cf" fill="#6B517E" stroke="#B2B2B2" strokeMiterlimit={10} points="1039.001,1.5 1149.5,0.5 1149.5,181" />
      </svg>
    </div>
  )
}
